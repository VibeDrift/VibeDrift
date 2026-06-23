#!/usr/bin/env node
// Score-discrimination harness.
//
// Reads repos.json, shallow-clones any git sources into .cache/, runs the REAL
// built CLI (`--local-only --json`) on each repo, and prints:
//   1. a table sorted by composite score
//   2. a clean-vs-messy separation summary
//   3. per-repo top-5 analyzer ids by finding count, with severity breakdown
//
// This MEASURES only. It changes no scoring or detector code.
//
// Usage:
//   node eval/discrimination/run.mjs            # clone missing repos, then scan
//   node eval/discrimination/run.mjs --no-clone # skip cloning, scan what exists

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CACHE_DIR = join(__dirname, ".cache");
const CLI_BIN = join(REPO_ROOT, "bin", "vibedrift.mjs");
const NO_CLONE = process.argv.includes("--no-clone");

function cacheKeyFromGit(gitUrl) {
  const m = gitUrl.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!m) return gitUrl.replace(/[^a-z0-9]+/gi, "-");
  return `${m[1]}-${m[2]}`;
}

function resolveRepoPath(entry) {
  const src = entry.source || {};
  if (src.path) {
    // Relative paths are resolved against this script's directory
    // (eval/discrimination/), so "fixtures/clean-lib" works as written.
    return isAbsolute(src.path) ? src.path : resolve(__dirname, src.path);
  }
  if (src.git) {
    const dest = join(CACHE_DIR, cacheKeyFromGit(src.git));
    if (existsSync(dest)) return dest;
    if (NO_CLONE) return null; // signal "not present, clone skipped"
    mkdirSync(CACHE_DIR, { recursive: true });
    process.stderr.write(`cloning ${src.git} -> ${dest}\n`);
    const r = spawnSync(
      "git",
      ["clone", "--depth", "1", "--quiet", src.git, dest],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 120000 },
    );
    if (r.status !== 0 || !existsSync(dest)) return null;
    return dest;
  }
  return null;
}

function scanRepo(repoPath) {
  // Returns parsed JSON or throws.
  const out = execFileSync(
    process.execPath,
    [CLI_BIN, repoPath, "--local-only", "--json"],
    { maxBuffer: 256 * 1024 * 1024, timeout: 600000, encoding: "utf8" },
  );
  // CLI may emit a banner before JSON; grab the first balanced top-level object.
  const start = out.indexOf("{");
  if (start < 0) throw new Error("no JSON object in CLI output");
  const json = out.slice(start);
  return JSON.parse(json);
}

const CATS = [
  ["arch", "architecturalConsistency"],
  ["redundancy", "redundancy"],
  ["security", "securityPosture"],
  ["intent", "intentClarity"],
];

function cat(scores, key) {
  const c = scores && scores[key];
  if (!c) return null;
  if (c.applicable === false) return "n/a";
  return Number(c.score);
}

function fmtNum(v, width) {
  if (v === null || v === undefined) return "-".padStart(width);
  if (v === "n/a") return "n/a".padStart(width);
  return Number(v).toFixed(1).padStart(width);
}

function topAnalyzers(findings, n) {
  const byId = new Map();
  for (const f of findings || []) {
    const id = f.analyzerId || "(unknown)";
    if (!byId.has(id)) byId.set(id, { total: 0, error: 0, warning: 0, info: 0 });
    const rec = byId.get(id);
    rec.total += 1;
    const sev = f.severity || "info";
    if (rec[sev] === undefined) rec[sev] = 0;
    rec[sev] += 1;
  }
  return [...byId.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, n)
    .map(([id, rec]) => ({ id, ...rec }));
}

// ---------------------------------------------------------------------------

const repos = JSON.parse(
  readFileSync(join(__dirname, "repos.json"), "utf8"),
);

const results = [];

for (const entry of repos) {
  const repoPath = resolveRepoPath(entry);
  if (!repoPath) {
    results.push({ entry, error: NO_CLONE ? "not cloned (--no-clone)" : "clone failed / unavailable" });
    continue;
  }
  if (!existsSync(repoPath)) {
    results.push({ entry, error: `path not found: ${repoPath}` });
    continue;
  }
  try {
    const j = scanRepo(repoPath);
    results.push({ entry, path: repoPath, json: j });
  } catch (err) {
    results.push({ entry, path: repoPath, error: String(err.message || err).slice(0, 160) });
  }
}

// Sort: successful by composite desc, errors last.
results.sort((a, b) => {
  if (a.error && b.error) return 0;
  if (a.error) return 1;
  if (b.error) return -1;
  return Number(b.json.compositeScore) - Number(a.json.compositeScore);
});

// ---- Table ----------------------------------------------------------------
const L = 36, K = 7, N = 11;
const header =
  "label".padEnd(L) + "kind".padEnd(K) +
  "composite".padStart(N) + "arch".padStart(8) +
  "redund".padStart(9) + "security".padStart(10) +
  "intent".padStart(8) + "hygiene".padStart(9);
const out = [];
out.push("# Score Discrimination Baseline");
out.push("");
out.push("Generated by `eval/discrimination/run.mjs` — REAL scanner, `--local-only`.");
out.push(`Date: ${new Date().toISOString()}`);
out.push("");
out.push("## Baseline table (sorted by composite)");
out.push("");
out.push("```");
out.push(header);
out.push("-".repeat(header.length));

for (const r of results) {
  const label = r.entry.label.slice(0, L - 1).padEnd(L);
  const kind = (r.entry.kind || "?").padEnd(K);
  if (r.error) {
    out.push(label + kind + "ERROR".padStart(N) + "  " + r.error);
    continue;
  }
  const j = r.json;
  const composite = Number(j.compositeScore);
  const row =
    label + kind +
    composite.toFixed(1).padStart(N) +
    fmtNum(cat(j.scores, "architecturalConsistency"), 8) +
    fmtNum(cat(j.scores, "redundancy"), 9) +
    fmtNum(cat(j.scores, "securityPosture"), 10) +
    fmtNum(cat(j.scores, "intentClarity"), 8) +
    fmtNum(j.hygieneScore ?? null, 9);
  out.push(row);
}
out.push("```");
out.push("");

// ---- Separation summary ---------------------------------------------------
function meanComposite(kind) {
  const vals = results
    .filter((r) => !r.error && r.entry.kind === kind)
    .map((r) => Number(r.json.compositeScore));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
const cleanMean = meanComposite("clean");
const midMean = meanComposite("mid");
const messyMean = meanComposite("messy");

out.push("## Separation summary");
out.push("");
out.push("```");
out.push(`clean mean composite : ${cleanMean === null ? "n/a" : cleanMean.toFixed(1)}`);
out.push(`mid   mean composite : ${midMean === null ? "n/a" : midMean.toFixed(1)}`);
out.push(`messy mean composite : ${messyMean === null ? "n/a" : messyMean.toFixed(1)}`);
if (cleanMean !== null && messyMean !== null) {
  out.push(`clean - messy gap    : ${(cleanMean - messyMean).toFixed(1)}`);
}
out.push("```");
out.push("");

// ---- Per-repo top analyzers ----------------------------------------------
out.push("## Per-repo top-5 analyzers (by finding count, severity breakdown)");
out.push("");
for (const r of results) {
  out.push(`### ${r.entry.label}  [${r.entry.kind}]`);
  if (r.error) {
    out.push(`  ERROR: ${r.error}`);
    out.push("");
    continue;
  }
  const j = r.json;
  out.push(
    `  composite ${Number(j.compositeScore).toFixed(1)}/100 | ` +
    `findings ${(j.findings || []).length} | lines ${j.totalLines ?? "?"} | files ${j.fileCount ?? "?"}`,
  );
  out.push("```");
  out.push("  analyzerId".padEnd(36) + "total".padStart(7) + "err".padStart(6) + "warn".padStart(6) + "info".padStart(6));
  for (const a of topAnalyzers(j.findings, 5)) {
    out.push(
      ("  " + a.id).slice(0, 36).padEnd(36) +
      String(a.total).padStart(7) +
      String(a.error || 0).padStart(6) +
      String(a.warning || 0).padStart(6) +
      String(a.info || 0).padStart(6),
    );
  }
  out.push("```");
  out.push("");
}

const report = out.join("\n");
process.stdout.write(report + "\n");

// Also write the markdown report to the SDD corpus dir, best-effort.
try {
  const target = "/Users/samiahmadkhan/workspace/Vibestack/.corpus-sdd/discrimination-baseline.md";
  mkdirSync(dirname(target), { recursive: true });
  execFileSync("/bin/sh", ["-c", "cat > " + JSON.stringify(target)], { input: report + "\n" });
  process.stderr.write(`\nwrote ${target}\n`);
} catch (e) {
  process.stderr.write(`\ncould not write baseline md: ${e.message}\n`);
}
