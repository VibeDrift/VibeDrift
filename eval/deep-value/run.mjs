#!/usr/bin/env node
// P0.0 paid-deep VALUE TEST harness.
//
// Question it answers: does the paid deep scan catch real things the free local
// scan misses (and that a developer would keep)? It measures only; it changes no
// scoring or detector code.
//
// For each repo in repos.json it:
//   1. clones the repo (pinned SHA when provided, best-effort otherwise),
//   2. runs the REAL built CLI twice:
//        (a) --local-only --json        FREE cross-check (should have zero ml- findings)
//        (b) --deep --verbose --json    METERED deep scan
//   3. extracts the "deep-only" findings (analyzerId starts with "ml-": these are
//      produced only by the deep pass, src/ml-client/confidence.ts),
//   4. parses droppedCount from the deep run's stderr (the only place it surfaces,
//      src/cli/commands/scan.ts:338),
//   5. writes a per-finding LABELING SHEET (out/labeling-sheet.jsonl) for the
//      keep/discard pass, plus a summary table (out/summary.md, also stdout).
//
// IMPORTANT honesty note baked into the output: the CLI droppedCount is the
// PRE-LLM embedding-confidence/quota drop, NOT "false alarms the LLM suppressed."
// The true LLM-suppression count lives only in the API (Fly) server logs.
//
// COST / PREREQUISITES (the --deep step only):
//   - each --deep run consumes ONE VibeDrift deep-scan allowance (Pro = 12/cycle),
//   - it spends metered Claude money on the API's Anthropic account,
//   - the machine must be logged in (`vibedrift login`) and able to reach the API.
//
// Usage:
//   node eval/deep-value/run.mjs --no-deep    # FREE: clone + local scan only (validates plumbing, no spend)
//   node eval/deep-value/run.mjs              # METERED: runs the deep scans
//   node eval/deep-value/run.mjs --no-clone   # reuse repos already in .cache/

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CACHE_DIR = join(__dirname, ".cache");
const OUT_DIR = join(__dirname, "out");
const CLI_BIN = join(REPO_ROOT, "bin", "vibedrift.mjs");

const NO_CLONE = process.argv.includes("--no-clone");
const NO_DEEP = process.argv.includes("--no-deep");
const reposIdx = process.argv.indexOf("--repos");
const REPOS_FILE = reposIdx >= 0 && process.argv[reposIdx + 1] ? process.argv[reposIdx + 1] : "repos.json";
const TAG = REPOS_FILE.replace(/\.json$/, "").replace(/^repos-?/, ""); // "" for repos.json, "messy" for repos-messy.json

const ML_PREFIX = "ml-";
const DUP_IDS = new Set(["ml-duplicate", "ml-reimplementation"]);
const INTENT_IDS = new Set(["ml-intent"]);
const ANOMALY_IDS = new Set(["ml-anomaly"]);

function cacheKeyFromGit(gitUrl) {
  const m = gitUrl.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!m) return gitUrl.replace(/[^a-z0-9]+/gi, "-");
  return `${m[1]}-${m[2]}`;
}

// Resolve / clone a repo. Returns { path, commit } or { error }.
function resolveRepo(entry) {
  const src = entry.source || {};
  if (src.path) {
    const p = isAbsolute(src.path) ? src.path : resolve(__dirname, src.path);
    return existsSync(p) ? { path: p, commit: gitCommit(p) } : { error: `path not found: ${p}` };
  }
  if (!src.git) return { error: "entry has no source.git or source.path" };

  const dest = join(CACHE_DIR, cacheKeyFromGit(src.git));
  if (existsSync(dest)) return { path: dest, commit: gitCommit(dest) };
  if (NO_CLONE) return { error: "not cloned (--no-clone)" };

  mkdirSync(CACHE_DIR, { recursive: true });
  process.stderr.write(`cloning ${src.git} -> ${dest}\n`);
  const clone = spawnSync("git", ["clone", "--depth", "1", "--quiet", src.git, dest], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 240000,
  });
  if (clone.status !== 0 || !existsSync(dest)) return { error: "clone failed" };

  // Best-effort SHA pin: shallow-fetch the exact commit, then detach onto it.
  if (src.sha) {
    const fetch = spawnSync("git", ["-C", dest, "fetch", "--depth", "1", "--quiet", "origin", src.sha], {
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120000,
    });
    if (fetch.status === 0) {
      spawnSync("git", ["-C", dest, "checkout", "--quiet", "FETCH_HEAD"], { stdio: "ignore" });
    } else {
      process.stderr.write(`  (could not pin sha ${src.sha}; using default HEAD)\n`);
    }
  }
  return { path: dest, commit: gitCommit(dest) };
}

function gitCommit(repoPath) {
  const r = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

// Run the real CLI once. deep=false -> --local-only (free). deep=true -> --deep --verbose (metered).
// Returns { json, stderr, droppedCount, shipped, unresolved } or { error }.
function runCli(repoPath, deep) {
  const args = deep
    ? [CLI_BIN, repoPath, "--deep", "--verbose", "--json"]
    : [CLI_BIN, repoPath, "--local-only", "--json"];
  const r = spawnSync(process.execPath, args, {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 900000,
    encoding: "utf8",
  });
  const stderr = r.stderr || "";
  if (r.status !== 0 && !(r.stdout || "").includes("{")) {
    return { error: `CLI exit ${r.status}: ${stderr.slice(-300).trim() || "no output"}` };
  }
  const out = r.stdout || "";
  const start = out.indexOf("{");
  if (start < 0) return { error: `no JSON in CLI output. stderr: ${stderr.slice(-200).trim()}` };
  let json;
  try {
    json = JSON.parse(out.slice(start));
  } catch (e) {
    return { error: `JSON parse failed: ${String(e.message).slice(0, 120)}` };
  }
  // Parse the deep stderr line: "[deep] X high-confidence ... , Y unresolved, Z dropped"
  let droppedCount = null, shipped = null, unresolved = null;
  const m = stderr.match(/\[deep\]\s+(\d+)\s+high-confidence[^,]*,\s*(\d+)\s+unresolved,\s*(\d+)\s+dropped/);
  if (m) {
    shipped = Number(m[1]);
    unresolved = Number(m[2]);
    droppedCount = Number(m[3]);
  }
  return { json, stderr, droppedCount, shipped, unresolved };
}

function mlFindings(json) {
  return (json.findings || []).filter((f) => (f.analyzerId || "").startsWith(ML_PREFIX));
}

function bucket(findings) {
  let dup = 0, intent = 0, anomaly = 0, other = 0;
  for (const f of findings) {
    const id = f.analyzerId || "";
    if (DUP_IDS.has(id)) dup++;
    else if (INTENT_IDS.has(id)) intent++;
    else if (ANOMALY_IDS.has(id)) anomaly++;
    else other++;
  }
  return { dup, intent, anomaly, other };
}

// --------------------------------------------------------------------------

const repos = JSON.parse(readFileSync(join(__dirname, REPOS_FILE), "utf8"));
mkdirSync(OUT_DIR, { recursive: true });

const rows = [];
const labelingLines = [];

for (const entry of repos) {
  process.stderr.write(`\n=== ${entry.label} (${entry.lang}) ===\n`);
  const resolved = resolveRepo(entry);
  if (resolved.error) {
    rows.push({ label: entry.label, lang: entry.lang, error: resolved.error });
    continue;
  }
  const { path: repoPath, commit } = resolved;

  // (a) free local cross-check
  process.stderr.write(`  local scan (free)...\n`);
  const local = runCli(repoPath, false);
  const localMl = local.error ? [] : mlFindings(local.json);

  if (NO_DEEP) {
    rows.push({
      label: entry.label, lang: entry.lang, commit, mode: "no-deep",
      localError: local.error || null,
      localComposite: local.error ? null : local.json.compositeScore,
      localFindings: local.error ? null : (local.json.findings || []).length,
      localMlFindings: localMl.length, // should be 0
    });
    continue;
  }

  // (b) metered deep scan
  process.stderr.write(`  DEEP scan (metered: 1 allowance + Claude $)...\n`);
  const deep = runCli(repoPath, true);
  if (deep.error) {
    rows.push({ label: entry.label, lang: entry.lang, commit, error: `deep: ${deep.error}` });
    continue;
  }

  const deepOnly = mlFindings(deep.json);
  const b = bucket(deepOnly);

  // one labeling-sheet line per deep-only finding
  for (const f of deepOnly) {
    labelingLines.push(JSON.stringify({
      repo: entry.label,
      repoPath,         // so a labeler/judge can open the actual code
      analyzerId: f.analyzerId,
      severity: f.severity,
      file: f.file ?? f.filePath ?? null,
      line: f.line ?? f.startLine ?? null,
      symbol: f.symbol ?? f.functionName ?? f.name ?? null,
      message: f.message ?? f.title ?? null,
      evidence: f.evidence ?? f.detail ?? null,
      finding: f,        // full object, nothing hidden
      label: "",         // "keep" | "discard"  (fill in)
      reason: "",        // labeler's one-line justification
    }));
  }

  rows.push({
    label: entry.label, lang: entry.lang, commit, mode: "deep",
    localComposite: local.error ? null : local.json.compositeScore,
    deepComposite: deep.json.compositeScore,
    localMlFindings: localMl.length,        // cross-check, expect 0
    deepOnlyTotal: deepOnly.length,
    dup: b.dup, intent: b.intent, anomaly: b.anomaly, other: b.other,
    shipped: deep.shipped, unresolved: deep.unresolved,
    droppedCount: deep.droppedCount,        // PRE-LLM drop, see honesty note
  });
}

// ---- write labeling sheet -------------------------------------------------
const sheetPath = join(OUT_DIR, `labeling-sheet${TAG ? "-" + TAG : ""}.jsonl`);
writeFileSync(sheetPath, labelingLines.join("\n") + (labelingLines.length ? "\n" : ""));

// ---- summary --------------------------------------------------------------
const lines = [];
lines.push("# P0.0 Paid-Deep Value Test — raw results");
lines.push("");
lines.push(`Date: ${new Date().toISOString()}`);
lines.push(`Mode: ${NO_DEEP ? "NO-DEEP (free plumbing check)" : "DEEP (metered)"}`);
lines.push("");
lines.push("Honesty note: `droppedCount` is the PRE-LLM embedding-confidence/quota drop");
lines.push("(src/cli/commands/scan.ts:338), NOT the count of false alarms the LLM suppressed.");
lines.push("The true LLM-suppression count is only in the API server logs.");
lines.push("");

if (NO_DEEP) {
  lines.push("```");
  lines.push("repo".padEnd(12) + "commit".padEnd(10) + "composite".padStart(10) + "findings".padStart(9) + "ml(expect 0)".padStart(13));
  for (const r of rows) {
    if (r.error || r.localError) { lines.push(r.label.padEnd(12) + "ERROR ".padEnd(10) + (r.error || r.localError)); continue; }
    lines.push(
      r.label.padEnd(12) + String(r.commit).slice(0, 8).padEnd(10) +
      String(r.localComposite ?? "-").padStart(10) +
      String(r.localFindings ?? "-").padStart(9) +
      String(r.localMlFindings ?? "-").padStart(13));
  }
  lines.push("```");
} else {
  lines.push("```");
  lines.push("repo".padEnd(12) + "deepOnly".padStart(9) + "dup".padStart(5) + "intent".padStart(7) + "anom".padStart(5) + "dropped".padStart(8) + "localComp".padStart(10) + "deepComp".padStart(9));
  for (const r of rows) {
    if (r.error) { lines.push(r.label.padEnd(12) + "ERROR  " + r.error); continue; }
    lines.push(
      r.label.padEnd(12) +
      String(r.deepOnlyTotal).padStart(9) + String(r.dup).padStart(5) +
      String(r.intent).padStart(7) + String(r.anomaly).padStart(5) +
      String(r.droppedCount ?? "-").padStart(8) +
      String(r.localComposite ?? "-").padStart(10) + String(r.deepComposite ?? "-").padStart(9));
  }
  lines.push("```");
  lines.push("");
  lines.push(`Cross-check: localMlFindings should be 0 for every repo. Actual: ` +
    rows.filter(r => !r.error).map(r => `${r.label}=${r.localMlFindings}`).join(", "));
  lines.push("");
  lines.push(`Labeling sheet: ${sheetPath} (${labelingLines.length} deep-only findings to label keep/discard).`);
  lines.push("Next: blind keep/discard pass, then the go/no-go is computed on KEPT counts.");
  lines.push("GO if median kept deep-only >= 3/repo or median keep rate >= 40%; NO-GO if median < 1.");
}

const report = lines.join("\n") + "\n";
const summaryPath = join(OUT_DIR, `summary${TAG ? "-" + TAG : ""}.md`);
writeFileSync(summaryPath, report);
process.stdout.write(report);
process.stderr.write(`\nwrote ${summaryPath} and ${sheetPath}\n`);
