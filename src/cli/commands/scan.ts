import { resolve } from "path";
import { canonicalizeRoot } from "../../core/baseline.js";
import { writeFile } from "fs/promises";
import { stat } from "fs/promises";
import chalk from "chalk";
import ora from "ora";
import { buildAnalysisContext, recomputeContextStats } from "../../core/discovery.js";
import { parseFiles } from "../../utils/ast.js";
import { createAnalyzerRegistry } from "../../analyzers/index.js";
import { runDriftDetection, attachEngineComposite, scoredDriftView } from "../../drift/index.js";
import { computeScores, applySecurityMinPeerFloor, applyReimplementationConcentrationGate, SCORING_VERSION } from "../../scoring/engine.js";
import { debug, setDebugEnabled } from "../../core/debug.js";
import { generateTeaseMessages, countReimplementationCandidates } from "../../output/tease.js";
import { renderTerminalOutput, renderConciseSummary, renderJsonOutput, renderStarCta, renderDashboardLink, renderLocalReportLink, DASHBOARD_SPINNER_TEXT, DASHBOARD_SPINNER_SUCCESS_SYMBOL } from "../../output/terminal.js";
import { renderHtmlReport } from "../../output/html.js";
import {
  saveScanResult,
  loadPreviousScores,
  loadPreviousHygieneScores,
  loadPreviousScoringVersion,
  loadLatestScan,
  loadScanById,
  computeFindingDigest,
  computeDriftFindingDigest,
} from "../../core/history.js";
import { diffScans } from "../../output/history-diff.js";
import { isCacheDisabled, pruneCache } from "../../core/findings-cache.js";
import { runAnalyzers } from "../../core/run-analyzers.js";
import { applyIncludeExclude, suggestExclusions } from "../../core/file-filter.js";
import { resolveToken, resolveApiUrl } from "../../auth/resolver.js";
import { fetchCredits } from "../../auth/api.js";
import type { Finding, ScanResult, ScanOptions } from "../../core/types.js";
import type { CodeDnaResult } from "../../codedna/types.js";

/**
 * ScanResult augmented with the internal, non-persisted markers this command
 * stashes on the result object during upload/render (all optional, prefixed
 * `__`). Kept local so the shared ScanResult type stays free of CLI-only state.
 */
type ScanResultAugmented = ScanResult & {
  __scanId?: string;
  __apiUrl?: string;
  __dashboardUrl?: string;
  __uploadTrimNote?: string;
  __uploadError?: string;
  __fixPromptsDone?: boolean;
};

/**
 * True when stdout must carry ONLY the machine-readable JSON document and
 * nothing else. Mirrors the format resolution at the render step:
 *   format = options.format ?? (options.json ? "json" : "html")
 * so a bare `--json` selects JSON, but an explicit `--format <x>` wins (the
 * shorthand only applies when no real format was given). Used to redirect
 * info/progress/notice messages to stderr so they never corrupt the JSON
 * a caller pipes into JSON.parse.
 */
export function isJsonOutput(options: ScanOptions): boolean {
  return (options.format ?? (options.json ? "json" : "html")) === "json";
}

/**
 * Emit a non-data info/progress/notice line. Under JSON output it goes to
 * stderr (stdout is reserved for the JSON payload); otherwise to stdout.
 */
function notice(options: ScanOptions, message: string): void {
  if (isJsonOutput(options)) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// ────────────────────────────────────────────────────────────────────
// 1. resolveAuthAndBanner
// ────────────────────────────────────────────────────────────────────
async function resolveAuthAndBanner(
  options: ScanOptions,
): Promise<{ bearerToken: string | null; apiUrl: string | undefined }> {
  // ──── Resolve token *before* the scan starts ────
  // Required for --deep (the API call would 401 anyway), but ALSO attempted
  // for free scans so we can log them to the user's dashboard. Free scans
  // without a token still work — they just don't appear in the dashboard.
  let bearerToken: string | null = null;
  let apiUrl: string | undefined = options.apiUrl;
  if (options.deep) {
    const resolved = await resolveToken();
    if (!resolved) {
      console.error("");
      console.error(chalk.red("  ✗ Deep scans require a VibeDrift account."));
      console.error("");
      console.error(chalk.bgYellow.black.bold("    🎁  Free accounts get 1 deep scan per month.    "));
      console.error("");
      console.error("    Run " + chalk.bold("vibedrift login") + " to sign in and claim it.");
      console.error("    Or set " + chalk.bold("VIBEDRIFT_TOKEN") + " in your environment for CI.");
      console.error("");
      process.exit(1);
    }
    bearerToken = resolved.token;
    apiUrl = await resolveApiUrl(options.apiUrl);
  } else {
    // Free scan: best-effort token resolution. If the user is logged in
    // we log the scan to their dashboard; if not, the local scan still
    // runs to completion.
    try {
      const resolved = await resolveToken();
      if (resolved) {
        bearerToken = resolved.token;
        apiUrl = await resolveApiUrl(options.apiUrl);
      }
    } catch {
      // ignore — free scans don't require auth
    }
  }

  // ──── Advertise the one-time welcome credit ────
  // Three cases:
  //   1. Logged in + has welcome credit unconsumed → "🎁 1 free deep scan ready"
  //   2. Logged in + already used / pro plan → no banner
  //   3. Not logged in → "Sign up to get 1 free deep scan"
  //
  // Visible for both `--format html` (default) and `--format terminal`,
  // suppressed for `--json` and explicit deep scans (the banner only
  // makes sense before a free scan, not during a deep one).
  if (!options.json && options.format !== "json" && !options.deep) {
    if (bearerToken) {
      try {
        // Cosmetic banner only — cap the wait hard so a slow/contended API
        // never delays the scan from even starting. If credits don't come back
        // in time we simply skip the banner.
        const credits = await fetchCredits(bearerToken, { apiUrl, timeoutMs: 2500 });
        if (credits.has_free_deep_scan && !credits.unlimited) {
          console.log("");
          console.log(chalk.bgYellow.black.bold("  🎁  1 FREE DEEP SCAN EVERY MONTH  "));
          console.log(chalk.yellow("    Run with --deep to use AI-powered analysis (1 free per month)."));
          console.log("");
        }
      } catch {
        // Older API build or transient error — skip the banner.
      }
    }
  }

  return { bearerToken, apiUrl };
}

// ────────────────────────────────────────────────────────────────────
// 2. runAnalysisPipeline
// ────────────────────────────────────────────────────────────────────
async function discoverAndFilterFiles(
  rootDir: string,
  options: ScanOptions,
  spinner: ReturnType<typeof ora> | null,
): Promise<{
  ctx: Awaited<ReturnType<typeof buildAnalysisContext>>["ctx"];
  discoveryMs: number;
}> {
  const isTerminal = options.format === "terminal" && !options.json;
  const t0 = Date.now();
  const { ctx, warnings } = await buildAnalysisContext(rootDir);

  // Carry the already-loaded project config (cli/index.ts loads it once to
  // resolve --format/--fail-on-score defaults) onto the context so the
  // Security Consistency detector's config glob allowlist can read it via
  // DriftContext.projectConfig. Undefined when the caller didn't load one
  // (e.g. watch mode) — the allowlist arm simply no-ops in that case.
  ctx.projectConfig = options.projectConfig;

  // Apply --include / --exclude glob filters in-place on the context's files.
  const includes = options.include ?? [];
  const excludes = options.exclude ?? [];
  if (includes.length > 0 || excludes.length > 0) {
    const before = ctx.files.length;
    const filtered = applyIncludeExclude(ctx.files, includes, excludes);
    ctx.files = filtered;
    recomputeContextStats(ctx);
    if (options.verbose) {
      console.error(chalk.dim(`[filter] ${before} → ${filtered.length} files after include/exclude`));
    }
  }

  // --diff: scope the scan to files changed in git. Most valuable with --deep
  // (deep-scan only what you changed). Falls back to a full scan, with a notice,
  // when the dir isn't a git repo so the flag never silently scans nothing.
  if (options.diff) {
    const ref = typeof options.diff === "string" ? options.diff : undefined;
    const { getChangedFiles } = await import("../../core/git-metadata.js");
    const changed = await getChangedFiles(rootDir, ref);
    if (changed === null) {
      if (isTerminal) {
        console.warn(chalk.yellow(`Warning: --diff needs a git repository; scanning all files instead.`));
      }
    } else {
      const before = ctx.files.length;
      const changedSet = new Set(changed);
      ctx.files = ctx.files.filter((f) => changedSet.has(f.relativePath));
      recomputeContextStats(ctx);
      if (options.verbose) {
        console.error(chalk.dim(`[diff] ${before} → ${ctx.files.length} changed file(s)${ref ? ` vs ${ref}` : ""}`));
      }
      if (ctx.files.length === 0) {
        if (spinner) spinner.stop();
        console.log(`No changed source files${ref ? ` vs ${ref}` : ""} to analyze.`);
        process.exit(0);
      }
    }
  }

  const discoveryMs = Date.now() - t0;

  // Report discovery warnings
  if (isTerminal) {
    if (warnings.truncated) {
      console.warn(chalk.yellow(`\nWarning: File limit reached (${warnings.truncatedAt}). Only partial coverage — results may be incomplete.`));
    }
    if (warnings.skippedDirs.length > 0) {
      console.warn(chalk.yellow(`Warning: ${warnings.skippedDirs.length} directories skipped (permission denied): ${warnings.skippedDirs.slice(0, 3).join(", ")}${warnings.skippedDirs.length > 3 ? "..." : ""}`));
    }
    if (warnings.unreadableFiles.length > 0) {
      console.warn(chalk.yellow(`Warning: ${warnings.unreadableFiles.length} files unreadable: ${warnings.unreadableFiles.slice(0, 3).join(", ")}${warnings.unreadableFiles.length > 3 ? "..." : ""}`));
    }
  }

  if (ctx.files.length === 0) {
    if (spinner) spinner.stop();
    console.log("No source files found to analyze.");
    process.exit(0);
  }

  return { ctx, discoveryMs };
}

async function runAnalysisPipeline(
  rootDir: string,
  options: ScanOptions,
  spinner: ReturnType<typeof ora> | null,
): Promise<{
  ctx: Awaited<ReturnType<typeof buildAnalysisContext>>["ctx"];
  allFindings: Finding[];
  driftResult: ReturnType<typeof runDriftDetection>;
  codeDnaResult: CodeDnaResult | undefined;
  timings: Record<string, number>;
}> {
  const isTerminal = options.format === "terminal" && !options.json;
  const timings: Record<string, number> = {};

  const { ctx, discoveryMs } = await discoverAndFilterFiles(rootDir, options, spinner);
  timings.discovery = discoveryMs;

  if (spinner) spinner.text = `Parsing ${ctx.files.length} files...`;

  // Parse ASTs
  const t1 = Date.now();
  await parseFiles(ctx.files);
  timings.parsing = Date.now() - t1;

  // Run analyzers
  const t2 = Date.now();
  const analyzers = createAnalyzerRegistry();
  if (spinner) spinner.text = `Running ${analyzers.length} analyzers...`;
  const allFindings: Finding[] = [];

  const cacheEnabled = options.cache !== false && !isCacheDisabled();

  // Analyzers run concurrently (pure/read-only over ctx); runAnalyzers
  // reassembles their findings in declaration order, so the result is identical
  // to the old sequential loop but overlaps cache I/O. Speeds up every scan and
  // every watch tick.
  const { findings: analyzerFindings, cacheHits, cacheMisses } = await runAnalyzers(
    analyzers,
    ctx,
    { rootDir, cacheEnabled },
  );
  for (const f of analyzerFindings) allFindings.push(f); // loop, not spread: unbounded set

  timings.analyzers = Date.now() - t2;

  if (options.verbose && cacheEnabled) {
    console.error(
      chalk.dim(
        `[cache] ${cacheHits} hits / ${cacheMisses} misses across ${analyzers.length} analyzers`,
      ),
    );
  }

  // Background prune — best effort, failures are silently ignored.
  if (cacheEnabled) {
    void pruneCache(rootDir).catch(() => { /* ignore */ });
  }

  // Run cross-file drift detection
  const t3 = Date.now();
  if (spinner) spinner.text = "Detecting vibe drift...";
  const driftResult = runDriftDetection(ctx);
  allFindings.push(...driftResult.findings);
  timings.drift = Date.now() - t3;

  // Run Code DNA analysis (Layer 1.7)
  let codeDnaResult: CodeDnaResult | undefined = undefined;
  if (options.codedna !== false) {
    const t4 = Date.now();
    if (spinner) spinner.text = "Running Code DNA analysis...";
    const { runCodeDnaAnalysis } = await import("../../codedna/index.js");
    codeDnaResult = runCodeDnaAnalysis(ctx);
    for (const f of codeDnaResult.findings) allFindings.push(f); // loop, not spread: unbounded set
    timings.codedna = Date.now() - t4;
    if (isTerminal && options.verbose) {
      console.error(`[codedna] ${codeDnaResult.functions.length} functions analyzed in ${codeDnaResult.timings.totalMs}ms`);
      console.error(`[codedna] ${codeDnaResult.duplicateGroups.length} fingerprint duplicates, ${codeDnaResult.sequenceSimilarities.length} sequence matches, ${codeDnaResult.taintFlows.length} taint flows`);
    }
  }

  return { ctx, allFindings, driftResult, codeDnaResult, timings };
}

// ────────────────────────────────────────────────────────────────────
// 3. runDeepAnalysis
// ────────────────────────────────────────────────────────────────────
async function runDeepAnalysis(
  pipeline: {
    allFindings: Finding[];
    ctx: Awaited<ReturnType<typeof buildAnalysisContext>>["ctx"];
    codeDnaResult: CodeDnaResult | undefined;
    driftResult: ReturnType<typeof runDriftDetection>;
  },
  options: ScanOptions,
  bearerToken: string,
  apiUrl: string | undefined,
  spinner: ReturnType<typeof ora> | null,
): Promise<{ timings: Record<string, number> }> {
  const { allFindings, ctx, codeDnaResult, driftResult } = pipeline;
  debug("deep", "entry: Layer 1 findings =", allFindings.length);
  const timings: Record<string, number> = {};

  // Run AI deep analysis (Layer 2) — opt-in with --deep
  let mlMediumConfidence: import("../../ml-client/types.js").MlFindingForLlm[] = [];
  const t5 = Date.now();
  if (spinner) spinner.text = "Running AI deep analysis (may take ~30s on cold start)...";
  try {
    const { runMlAnalysis } = await import("../../ml-client/index.js");
    const mlResult = await runMlAnalysis(ctx, codeDnaResult, allFindings, {
      token: bearerToken,
      apiUrl,
      verbose: options.verbose,
      driftFindings: driftResult.driftFindings,
      projectName: options.projectName,
    });
    allFindings.push(...mlResult.highConfidence);
    mlMediumConfidence = mlResult.mediumConfidence;
    // Record a successful deep scan (the API actually returned) so `vibedrift
    // status` and the deep-scan nudge can show "last deep scan N ago".
    const { patchConfig } = await import("../../auth/config.js");
    await patchConfig({ lastDeepScanAt: new Date().toISOString() });
    if (options.verbose) {
      // Claude validation runs SERVER-SIDE now (the API picks the borderline
      // findings, validates them in one batched call, and folds verdicts back:
      // confirmed findings arrive already boosted into highConfidence, rejected
      // ones are dropped before we ever see them). What's left in
      // mediumConfidence is the residue Claude was uncertain about or that
      // exceeded the validation cap — we don't ship those as confident findings.
      console.error(`[deep] ${mlResult.highConfidence.length} high-confidence findings shipped (incl. Claude-confirmed), ${mlResult.mediumConfidence.length} unresolved, ${mlResult.droppedCount} dropped`);
    }
  } catch (err) {
    console.error(chalk.red(`[deep] AI analysis failed: ${(err as Error).message}`));
    console.error(chalk.dim("       The local scan will continue. Run `vibedrift doctor` if this persists."));
  }
  timings.deep = Date.now() - t5;

  // Deduplicate findings across layers (AI > Code DNA > Static)
  const { deduplicateFindingsAcrossLayers } = await import("../../scoring/dedup.js");
  const dedupedCount = allFindings.length;
  const dedupedFindings = deduplicateFindingsAcrossLayers(allFindings);
  if (options.verbose && dedupedFindings.length < dedupedCount) {
    console.error(`[dedup] Removed ${dedupedCount - dedupedFindings.length} cross-layer duplicate findings`);
  }
  debug("deep", "after ML merge =", allFindings.length, "→ deduped =", dedupedFindings.length);
  // Replace allFindings with deduplicated version. Loop, not spread: spreading
  // a whole finding set as call arguments risks a RangeError past the engine's
  // argument limit on very large repos.
  allFindings.length = 0;
  for (const f of dedupedFindings) allFindings.push(f);
  debug("deep", "findings handed to scoring =", allFindings.length);

  // mlMediumConfidence now holds only the findings the server-side Claude
  // validation left UNRESOLVED (uncertain, or beyond the per-scan validation
  // cap). They are intentionally not shipped — surfacing an unvalidated
  // "maybe" as a finding is exactly the false-positive noise deep scan exists
  // to remove. Retained as a local for the verbose summary above.
  void mlMediumConfidence;

  return { timings };
}

// ────────────────────────────────────────────────────────────────────
// 4. buildScanResult
// ────────────────────────────────────────────────────────────────────
async function buildScanResult(
  pipeline: {
    ctx: Awaited<ReturnType<typeof buildAnalysisContext>>["ctx"];
    allFindings: Finding[];
    driftResult: ReturnType<typeof runDriftDetection>;
    codeDnaResult: CodeDnaResult | undefined;
  },
  options: ScanOptions,
  startTime: number,
  timings: Record<string, number>,
  bearerToken: string | null,
  signedIn: boolean,
  apiUrl: string | undefined,
  spinner: ReturnType<typeof ora> | null,
): Promise<ScanResult> {
  const { ctx, allFindings, driftResult, codeDnaResult } = pipeline;
  debug("scan", "scoring", allFindings.length, "findings over", ctx.totalLines, "lines");
  const rootDir = ctx.rootDir;

  // Load previous scores for delta (both drift and hygiene tracks) + the
  // SCORING_VERSION they were computed under. When the version differs from
  // the current engine's, delta arrows are silently suppressed (no banner)
  // and a one-time scoring-refined notice is shown instead.
  const previousScores = await loadPreviousScores(rootDir);
  const previousHygieneScores = await loadPreviousHygieneScores(rootDir);
  const previousScoringVersion = await loadPreviousScoringVersion(rootDir);

  // Demote thin (below-floor) route-consistency security findings to the
  // advisory hygiene id BEFORE this array becomes result.findings. Applied
  // here (not only inside computeScores) so the re-tag reaches every render
  // path that reads result.findings directly (terminal hygiene pane, HTML
  // hygiene section). computeScores only ever saw a local copy, so a finding
  // re-tagged there never made it back to the rendered set. Mutates
  // allFindings in place, mirroring the dedup replace above, so every
  // downstream reader of this same array reference (result.findings, the
  // tease generator, the diff digests) sees the demoted id. computeScores
  // re-applies the same floor on its own copy for standalone callers and
  // tests; that second pass is a no-op here since the ids are already advisory.
  const flooredFindings = applySecurityMinPeerFloor(allFindings);
  if (flooredFindings !== allFindings) {
    allFindings.length = 0;
    for (const f of flooredFindings) allFindings.push(f);
  }

  // Same "local copy" propagation class as the floor above: computeScores
  // applies the reimplementation concentration gate to its own copy of the
  // findings, so a re-tag happening only there never reaches result.findings —
  // a concentrated reimplementation finding would dent the score yet still
  // render and label as hygiene on every surface (terminal, HTML, CSV, DOCX,
  // context.md). Hoist the gate here, mutating allFindings in place, so every
  // downstream reader sees the drift-kind id the score is built on.
  // computeScores re-applies the gate to the already re-tagged set as a no-op
  // (it only matches the hygiene id), so standalone callers stay correct.
  const gatedFindings = applyReimplementationConcentrationGate(allFindings, ctx.totalLines);
  if (gatedFindings !== allFindings) {
    allFindings.length = 0;
    for (const f of gatedFindings) allFindings.push(f);
  }

  // Score
  if (spinner) spinner.text = "Computing scores...";
  const {
    scores,
    compositeScore,
    maxCompositeScore,
    hygieneScores,
    hygieneScore,
    maxHygieneScore,
    perFileScores,
    percentile,
    peerLanguage,
    scoringVersion,
    previousScoresMismatch,
  } = computeScores(
    allFindings,
    ctx.totalLines,
    ctx,
    previousScores ?? undefined,
    {
      previousHygieneScores: previousHygieneScores ?? undefined,
      previousScoringVersion: previousScoringVersion ?? undefined,
    },
  );

  // Deep insights are reserved for the premium AI tier (routed via VibeDrift API).
  // No direct Anthropic key path is exposed to end users.
  const deepInsights: ScanResult["deepInsights"] = [];

  // Tease — show "run --deep" upsell only when user is *not* using deep mode.
  // Pass codeDnaResult so the tease can name specific near-duplicate files
  // and opaque-named functions deep scan would confirm, not generic copy.
  const teaseMessages = generateTeaseMessages(ctx, allFindings, options.deep === true, codeDnaResult, signedIn);
  // Free Tier-1 reimplementation teaser (count only). Skipped on deep scans —
  // there the real panel-confirmed ml-reimplementation findings render instead.
  const reimplementationCandidates = options.deep
    ? 0
    : countReimplementationCandidates(codeDnaResult?.functions ?? []);

  const scanTimeMs = Date.now() - startTime;
  if (spinner) spinner.stop();

  // Print timing breakdown so the user knows what's taking time
  const layer1Ms = (timings.discovery ?? 0) + (timings.parsing ?? 0) + (timings.analyzers ?? 0) + (timings.drift ?? 0);
  const parts = [`Layer 1: ${(layer1Ms / 1000).toFixed(1)}s`];
  if (timings.codedna) parts.push(`Code DNA: ${(timings.codedna / 1000).toFixed(1)}s`);
  if (timings.deep) parts.push(`AI: ${(timings.deep / 1000).toFixed(1)}s`);
  parts.push(`Total: ${(scanTimeMs / 1000).toFixed(1)}s`);
  console.error(chalk.dim(`  ${parts.join(" · ")}`));

  // The DRIFT representation that rendering reads excludes below-floor
  // route-consistency security findings (demoted to advisory; still present in
  // `allFindings`/`result.findings` as hygiene-kind so we are never silent).
  // Applied before the diff so saved scans and the diff digest agree with the
  // rendered output — a below-floor advisory never appears as "new drift" in
  // the comparison banner. driftResult.driftFindings itself is untouched so
  // the baseline (assembleBaseline) still reads the raw representation.
  const rendered = scoredDriftView(driftResult.driftFindings ?? [], ctx.totalLines);

  // Scan-over-scan diff. Defaults to enabled; `--no-compare` opts out.
  // `--since` overrides the default "latest prior scan" target.
  let diff: ScanResult["diff"];
  if (options.compare !== false) {
    const previous = options.since
      ? await loadScanById(rootDir, options.since)
      : await loadLatestScan(rootDir);
    if (previous) {
      diff = diffScans(previous, {
        timestamp: new Date().toISOString(),
        compositeScore,
        hygieneScore,
        findingDigests: allFindings.slice(0, 200).map(computeFindingDigest),
        driftFindingDigests: (rendered.driftFindings ?? []).slice(0, 100).map(computeDriftFindingDigest),
        // Lets diffScans refuse cross-version comparisons for THIS pair —
        // `previousScoresMismatch` only covers the latest scan, but `--since`
        // can target any older scan, including one from a prior engine.
        scoringVersion,
      });
    }
  }

  const result: ScanResult = {
    context: ctx,
    findings: allFindings,
    driftFindings: rendered.driftFindings,
    // Mirror the single authoritative composite onto driftScores so the
    // uploaded payload + dashboard (result_json.driftScores.composite) match
    // the headline. One composite formula (the engine) — see Phase 0 collapse.
    driftScores: attachEngineComposite(rendered.driftScores, compositeScore),
    scores,
    compositeScore,
    maxCompositeScore,
    percentile,
    peerLanguage,
    hygieneScores,
    hygieneScore,
    maxHygieneScore,
    teaseMessages,
    reimplementationCandidates,
    deepInsights,
    scanTimeMs,
    perFileScores,
    codeDnaResult,
    diff,
    scoringVersion,
    previousScoresMismatch,
  };

  // AI Summary (when --deep is enabled, call the VibeDrift API for an executive summary)
  if (options.deep && bearerToken) {
    if (spinner) spinner.text = "Generating AI summary...";
    try {
      const { fetchAiSummary } = await import("../../ml-client/summarize.js");
      const targetUrl = apiUrl ?? "https://vibedrift-api.fly.dev";
      if (options.verbose) console.error(`[summary] Calling ${targetUrl}/v1/summarize...`);
      const summary = await fetchAiSummary(result, targetUrl, bearerToken);
      if (summary) {
        result.aiSummary = summary;
        if (options.verbose) console.error(`[summary] AI summary generated (${summary.highlights.length} highlights)`);
      } else {
        if (options.verbose) console.error(`[summary] API returned null`);
      }
    } catch (err) {
      if (options.verbose) console.error(`[summary] Failed: ${(err as Error).message}`);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────
// 5. logAndRender
// ────────────────────────────────────────────────────────────────────
async function writeContextIfRequested(
  result: ScanResult,
  options: ScanOptions,
  rootDir: string,
  paid: boolean,
): Promise<void> {
  if (!options.writeContext && !options.injectContext) return;
  const { basename } = await import("path");
  const projectName = options.projectName ?? basename(rootDir);
  try {
    if (options.writeContext) {
      const { writeContextFiles } = await import("../../output/context-md.js");
      const { written, note } = await writeContextFiles(rootDir, result, projectName, paid);
      console.log("");
      console.log(chalk.green(`  ✓ Wrote ${written.length} files to .vibedrift/`));
      for (const f of written) {
        console.log(chalk.dim(`    ${f}`));
      }
      if (note) {
        console.log("");
        console.log(chalk.yellow(`    ${note}`));
      } else {
        console.log(chalk.dim("    Commit these to share your codebase's dominant patterns with your team."));
      }
      console.log("");
    }
    if (options.injectContext) {
      const { buildContextMarkdown } = await import("../../output/context-md.js");
      const { injectContext } = await import("../../output/inject-context.js");
      const md = buildContextMarkdown(result, projectName, paid);
      const injected = await injectContext(rootDir, md);
      console.log(chalk.green(`  ✓ Injected context into ${injected.join(", ")}`));
    }
  } catch (err) {
    console.error(chalk.red(`  ✗ Failed to write/inject context: ${(err as Error).message}`));
  }
}

// Test-only re-export (kept at module scope, tree-shaken from the bundle).
export const __test_writeContextIfRequested = writeContextIfRequested;

export async function logAndRender(
  result: ScanResult,
  options: ScanOptions,
  bearerToken: string | null,
  apiUrl: string | undefined,
  rootDir: string,
  codeDnaResult: CodeDnaResult | undefined,
  paid: boolean,
  plan?: import("../../auth/plan.js").Plan,
): Promise<void> {
  const { compositeScore } = result;

  const format = options.format ?? (options.json ? "json" : "html");
  // The html loader path prints the summary first, then runs the slow network
  // work (AI fix-prompt synthesis, then the dashboard sync) behind sequential
  // spinners — so the user sees results instantly and watches progress instead
  // of a silent multi-second hang. Every other path runs that work up front.
  const htmlLoaderPath = !!bearerToken && format === "html" && !options.json;

  // Rich fix-prompt prose (PAID). Attaches metadata.fixPromptProse used by the
  // dashboard/HTML report. Skipped if already synthesized (--write-context does
  // it earlier, before its files are written). Best-effort.
  const needsFixPrompts = (): boolean =>
    !!bearerToken && paid && !(result as ScanResultAugmented).__fixPromptsDone;
  const runFixPrompts = async (): Promise<void> => {
    if (!needsFixPrompts()) return;
    try {
      const { synthesizeFixPrompts } = await import("../../ml-client/fix-prompts.js");
      await synthesizeFixPrompts(result.findings, result.context, {
        token: bearerToken as string,
        apiUrl,
        verbose: options.verbose,
      });
    } catch (err) {
      if (options.verbose) console.error(`[fix-prompts] skipped: ${(err as Error).message ?? err}`);
    } finally {
      (result as ScanResultAugmented).__fixPromptsDone = true;
    }
  };

  if (bearerToken && !htmlLoaderPath) {
    // Non-loader paths (json/terminal/csv/docx): synthesize prose then log, both
    // up front. These formats don't render the loader UX.
    await runFixPrompts();
    await uploadScanToDashboard(result, options, bearerToken, apiUrl, rootDir, codeDnaResult, {
      showSyncLine: !options.json,
      quiet: false,
    });
  }

  if (!bearerToken && format === "html") {
    // Unauthenticated html: the full report is no longer gated. Render the
    // complete report (every finding, drift detail, exact duplicate) and serve
    // it on localhost so anyone gets it, not a teaser. Authenticated users get
    // the dashboard link instead (handled in renderToFormat below).
    await serveHtmlReportOnLocalhost(result, options, paid, plan);
  } else {
    // Build the deferred loader steps for the html path: first the AI fix-prompt
    // synthesis (Pro), then the dashboard sync. Each runs behind its own spinner
    // after the summary is on screen.
    const deferredSteps: DeferredStep[] = [];
    if (htmlLoaderPath) {
      if (needsFixPrompts()) {
        deferredSteps.push({
          text: chalk.dim("Getting your AI fix prompts…"),
          doneText: "AI fix prompts ready",
          run: runFixPrompts,
        });
      }
      deferredSteps.push({
        text: DASHBOARD_SPINNER_TEXT,
        run: () =>
          uploadScanToDashboard(result, options, bearerToken as string, apiUrl, rootDir, codeDnaResult, {
            showSyncLine: false,
            quiet: true,
          }),
      });
    }
    await renderToFormat(result, format, options, paid, plan, deferredSteps);
  }

  // Fail on score threshold
  if (options.failOnScore !== undefined && compositeScore < options.failOnScore) {
    process.exit(1);
  }
}

/** One deferred, post-summary step on the html loader path: a labeled spinner
 *  wrapping a best-effort async task (fix-prompt synthesis, dashboard sync). */
interface DeferredStep {
  text: string;
  /** If set, the spinner persists a green-check line with this text when done;
   *  otherwise it just clears (e.g. the sync step, followed by the link box). */
  doneText?: string;
  run: () => Promise<void>;
}

/**
 * Unauthenticated html path: render the FULL report (no longer gated) and serve
 * it on localhost so the user opens it in their browser with working internal
 * links (the summary links to the detailed view by relative path). The command
 * stays alive serving until Ctrl+C, with a 10-minute auto-close as a backstop.
 * Authenticated scans link to the dashboard instead (see renderToFormat).
 */
async function serveHtmlReportOnLocalhost(
  result: ScanResult,
  options: ScanOptions,
  paid: boolean,
  plan?: import("../../auth/plan.js").Plan,
): Promise<void> {
  // High-level summary on stdout first.
  console.log(renderConciseSummary(result, plan));

  // The full report. Unauthenticated, so no report-open beacon (no scanId/token).
  const summaryHtml = renderHtmlReport(result, "summary", {}, { isPaid: paid });
  const detailedHtml = renderHtmlReport(result, "detailed", {}, { isPaid: paid });

  // Keep a copy on disk only when explicitly asked, so we don't litter the CWD.
  if (options.output) {
    const detailedPath = options.output.replace(/(\.html?)?$/i, "-detailed.html");
    await writeFile(options.output, summaryHtml);
    await writeFile(detailedPath, detailedHtml);
  }

  const { createServer } = await import("http");
  const { openInBrowser } = await import("../../auth/browser.js");
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end((req.url ?? "/").includes("detailed") ? detailedHtml : summaryHtml);
  });
  // Don't crash if the port is taken — surface it and keep the scan a success.
  server.on("error", (err: Error) => {
    notice(options, chalk.yellow(`  ⚠ Couldn't start the local report server: ${err.message}`));
    if (options.output) notice(options, chalk.dim(`    The report was written to ${options.output}.`));
  });
  const port = 4173 + Math.floor(Math.random() * 100);
  // Auto-close after 10 minutes; Ctrl+C closes immediately.
  const closeTimer = setTimeout(() => { server.close(); process.exit(0); }, 600_000);
  process.on("SIGINT", () => { clearTimeout(closeTimer); server.close(); process.exit(0); });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(renderLocalReportLink(url));
    if (openInBrowser(url)) {
      console.log(chalk.dim("  Opening it in your browser…"));
    } else {
      console.log(`  Open it: ${chalk.underline.cyan(url)}`);
    }
    console.log("");
    console.log(
      `  ${chalk.yellow("→")} Sign in to track your score over time: ` +
        `${chalk.underline.cyan("https://vibedrift.ai/login")} ${chalk.dim("(free, 30s)")}`,
    );
    console.log("");
    for (const line of renderStarCta()) console.log(line);
    console.log("");
    console.log(chalk.dim("  Report server is running. Press Ctrl+C to stop."));
  });
}

/**
 * Upload the scan to the dashboard (logScan). Mutates `result` with __scanId,
 * __apiUrl and __dashboardUrl (the last set only on success). The scan already
 * succeeded locally, so a failed upload is non-fatal.
 *
 * In `quiet` mode (the html loader path, where a spinner owns the line) it
 * stashes any trim / failure message on the result instead of printing it, so
 * the caller can render it cleanly after stopping the spinner.
 */
async function uploadScanToDashboard(
  result: ScanResult,
  options: ScanOptions,
  bearerToken: string,
  apiUrl: string | undefined,
  rootDir: string,
  codeDnaResult: CodeDnaResult | undefined,
  opts: { showSyncLine: boolean; quiet: boolean },
): Promise<void> {
  const { findings: allFindings, compositeScore, maxCompositeScore, scanTimeMs } = result;
  // The CLI's full ScanResult (sanitized) is the single source of truth. The
  // dashboard's metadata strip and the report it renders both derive from this
  // object, so they stay consistent. Runs for free and deep scans alike.
  try {
    const { logScan } = await import("../../ml-client/log-scan.js");
    const { detectProjectIdentity, detectLocalDisplayName } = await import("../../ml-client/project-name.js");
    const { sanitizeResultForUpload } = await import("../../ml-client/sanitize-result.js");
    const projectIdentity = await detectProjectIdentity(rootDir, options.projectName, options.private);
    // Local display name for the HTML report fallback.
    const localDisplayName = options.private
      ? projectIdentity.name
      : await detectLocalDisplayName(rootDir, options.projectName);

    // Tally per-detector ML counts (only present for deep scans).
    const mlDuplicates = allFindings.filter((f) => f.analyzerId === "ml-duplicate").length;
    const mlIntent = allFindings.filter((f) => f.analyzerId === "ml-intent").length;
    const mlAnomaly = allFindings.filter((f) => f.analyzerId === "ml-anomaly").length;

    // Letter grade — MUST match src/output/html.ts gradeFor() so the
    // dashboard's metadata strip agrees with the report. (A=90 B=75 C=50 D=25 F)
    const pct = maxCompositeScore > 0 ? (compositeScore / maxCompositeScore) * 100 : 0;
    const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 50 ? "C" : pct >= 25 ? "D" : "F";

    const sanitizedResult = sanitizeResultForUpload(result);
    // Stamp the project identity (the sanitizer doesn't know it). Local report
    // gets the display name; the server upload gets the hash only.
    (sanitizedResult.project as Record<string, unknown>) = {
      name: localDisplayName,
      hash: projectIdentity.hash,
    };
    sanitizedResult.grade = grade;
    sanitizedResult.scanType = options.deep ? "deep" : "free";
    sanitizedResult.scannedAt = new Date().toISOString();

    // Non-loader paths show a status line (stderr keeps --json stdout clean) so
    // a several-second sync on a large repo doesn't look like a hang. The loader
    // path suppresses it — the spinner is the status indicator there.
    if (opts.showSyncLine) {
      console.error(chalk.dim("  Syncing scan to your dashboard…"));
    }
    const logResult = await logScan({
      token: bearerToken,
      apiUrl,
      verbose: options.verbose,
      payload: {
        project_hash: projectIdentity.hash,
        project_name: projectIdentity.name,
        language: result.context.dominantLanguage ?? "unknown",
        file_count: result.context.files.length,
        total_lines: result.context.totalLines,
        function_count: codeDnaResult?.functions?.length ?? 0,
        finding_count: allFindings.length,
        score: compositeScore,
        grade,
        duplicates_found: mlDuplicates,
        intent_mismatches: mlIntent,
        anomalies_found: mlAnomaly,
        is_deep: !!options.deep,
        processing_time_ms: scanTimeMs,
        result_json: sanitizedResult,
      },
    });
    if (logResult.scanId) {
      (result as ScanResultAugmented).__scanId = logResult.scanId;
      (result as ScanResultAugmented).__apiUrl = apiUrl;
      // The scan is on the dashboard. Its project page URL is the first 12 chars
      // of the project hash (matches the dashboard's own links), so authed users
      // get a link there instead of a local HTML file.
      (result as ScanResultAugmented).__dashboardUrl =
        `https://vibedrift.ai/dashboard/projects/${projectIdentity.hash.slice(0, 12)}`;
      // Surface a trim notice if the payload was compacted before upload.
      if (logResult.trimmedFields && logResult.trimmedFields.length > 0) {
        const before = Math.round((logResult.initialBytes ?? 0) / 1024 / 1024);
        const after = Math.round((logResult.finalBytes ?? 0) / 1024 / 1024);
        const msg = chalk.dim(
          `  ⓘ Result trimmed for upload: ${before}MB → ${after}MB ` +
            `(stripped ${logResult.trimmedFields.join(", ")}). Local report unaffected.`,
        );
        if (opts.quiet) (result as ScanResultAugmented).__uploadTrimNote = msg;
        else notice(options, msg);
      }
    } else {
      const reason = logResult.error ?? "unknown error";
      const sizeNote =
        logResult.finalBytes && logResult.finalBytes > 5_000_000
          ? ` (payload ${Math.round(logResult.finalBytes / 1024 / 1024)}MB)`
          : "";
      if (opts.quiet) {
        (result as ScanResultAugmented).__uploadError = `${reason}${sizeNote}`;
      } else {
        notice(options, chalk.yellow(`  ⚠ Couldn't upload scan to dashboard${sizeNote}: ${reason}`));
        notice(options, chalk.dim(`    Run with --verbose for full details. Local report still saved.`));
      }
    }
  } catch (err) {
    if (opts.quiet) {
      (result as ScanResultAugmented).__uploadError = (err as Error).message;
    } else {
      notice(options, chalk.yellow(`  ⚠ Couldn't upload scan to dashboard: ${(err as Error).message}`));
    }
    if (options.verbose) {
      console.error(chalk.dim((err as Error).stack ?? ""));
    }
  }
}

async function renderToFormat(
  result: ScanResult,
  format: string,
  options: ScanOptions,
  paid: boolean,
  plan?: import("../../auth/plan.js").Plan,
  // Deferred steps for the html loader path: each runs behind its own spinner
  // after the summary prints (AI fix prompts, then the dashboard sync). Empty
  // for every other path.
  deferredSteps: DeferredStep[] = [],
): Promise<void> {
  // Fixture/generated-code nudge. Surfaces the exclude feature when scored
  // files look like test inputs or generated code, so users discover it
  // instead of silently scoring code they don't own. Auto-suppresses once a
  // .vibedriftignore is in place (those files never reach the scanned set).
  // Never on --format json — that stream must stay machine-parseable.
  if (format !== "json") {
    const suggestion = suggestExclusions([...result.perFileScores.keys()]);
    if (suggestion.count >= 5) {
      console.log("");
      console.log(
        chalk.dim(`  ℹ ${suggestion.count} scanned files look like fixtures or generated code.`),
      );
      console.log(
        chalk.dim(
          `    Skip them:  vibedrift ignore ${suggestion.globs.map((g) => `"${g}"`).join(" ")}`,
        ),
      );
      console.log(chalk.dim(`    Or run  vibedrift init  for guided setup (excludes, CI floor, format).`));
    }
  }

  if (format === "html") {
    // Print a tight, scannable high-level summary on stdout right away: the
    // update banner, scan header, Vibe Drift Score with category bars and the
    // Hygiene Score, and the top fixes. The complete detail lives on the
    // dashboard (or the local HTML report fallback).
    console.log(renderConciseSummary(result, plan));

    // Loader UX: results are on screen, so run the slow network work behind
    // sequential spinners — "Getting your AI fix prompts…" then "Generating
    // your dashboard link…". The user watches progress instead of a silent hang.
    for (const step of deferredSteps) {
      const spinner = ora({ text: step.text, color: "cyan" }).start();
      try {
        await step.run();
      } finally {
        if (step.doneText) {
          spinner.stopAndPersist({
            symbol: DASHBOARD_SPINNER_SUCCESS_SYMBOL,
            text: chalk.dim(step.doneText),
          });
        } else {
          spinner.stop();
        }
      }
    }

    const dashboardUrl = (result as ScanResultAugmented).__dashboardUrl;
    const trimNote = (result as ScanResultAugmented).__uploadTrimNote;
    if (trimNote) console.log(trimNote);

    // Authenticated + uploaded: the scan lives on the dashboard (persistent,
    // shareable, full detail). Link there and SKIP the local HTML render — it is
    // the slow part of the command. Only write a local file when there's no
    // dashboard entry (upload failed / offline) or the user asked with --output.
    const writeLocalReport = !dashboardUrl || !!options.output;

    if (writeLocalReport) {
      const scanId = (result as ScanResultAugmented).__scanId;
      const beaconApiUrl = (result as ScanResultAugmented).__apiUrl;
      const beaconOpts = { ...(scanId ? { scanId, beaconApiUrl } : {}), isPaid: paid };
      const summaryHtml = renderHtmlReport(result, "summary", {}, beaconOpts);
      const detailedHtml = renderHtmlReport(result, "detailed", {}, beaconOpts);
      const outputPath = options.output ?? "vibedrift-report.html";
      const detailedPath = outputPath.replace(/(\.html?)?$/i, "-detailed.html");
      await writeFile(outputPath, summaryHtml);
      await writeFile(detailedPath, detailedHtml);

      if (!dashboardUrl) {
        // No dashboard entry. Open the local report directly via file:// — the
        // report links to the detailed file by relative path, so file:// works.
        // No long-lived server, no 10-minute hang.
        const uploadError = (result as ScanResultAugmented).__uploadError;
        if (uploadError) {
          console.log(
            `\n  ${chalk.yellow("⚠")} ${chalk.dim(`Couldn't sync to your dashboard (${uploadError}). Opened a local report instead.`)}`,
          );
        }
        const { pathToFileURL } = await import("url");
        const { openInBrowser } = await import("../../auth/browser.js");
        const fileUrl = pathToFileURL(resolve(outputPath)).href;
        console.log(`\n  ${chalk.dim("Full report (every finding, drift detail, and duplicates):")}`);
        console.log(`  Report saved to ${chalk.bold(outputPath)}`);
        if (openInBrowser(fileUrl)) {
          console.log(chalk.dim("  Opening it in your browser…"));
        } else {
          console.log(`  Open it: \x1b[36m${fileUrl}\x1b[0m`);
        }
      } else {
        console.log(`\n  ${chalk.dim(`Report also written to ${outputPath}`)}`);
      }
    }

    if (dashboardUrl) {
      console.log(renderDashboardLink(dashboardUrl));
    }
    console.log("");
    for (const line of renderStarCta()) console.log(line);
  } else if (format === "csv") {
    const { renderCsvReport } = await import("../../output/csv.js");
    const csv = renderCsvReport(result);
    const outputPath = options.output ?? "vibedrift-report.csv";
    await writeFile(outputPath, csv);
    console.log(`CSV report written to ${outputPath}`);
  } else if (format === "docx") {
    const { renderDocxReport } = await import("../../output/docx.js");
    const docx = renderDocxReport(result);
    const outputPath = options.output ?? "vibedrift-report.docx";
    await writeFile(outputPath, docx);
    console.log(`DOCX report written to ${outputPath}`);
  } else if (format === "json") {
    const json = renderJsonOutput(result);
    if (options.output) {
      await writeFile(options.output, json);
      console.log(`JSON report written to ${options.output}`);
    } else {
      console.log(json);
    }
  } else {
    console.log(renderTerminalOutput(result, { plan }));
  }
}

// ────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────
// Subcommands a user might type as a bare token. `scan` runs when no command is
// given, so a bare `vibedrift <name>` on an UP-TO-DATE CLI routes to the command.
// On a build too old to have that command, Commander falls through to the default
// scan and treats the name as a [path] argument, producing a baffling
// "Error: .../mcp does not exist". This list lets us catch that case and tell the
// user the real cause (a stale CLI) instead. Keep in sync with src/cli/index.ts.
const KNOWN_SUBCOMMANDS = new Set([
  "init",
  "ignore",
  "watch",
  "telemetry",
  "login",
  "logout",
  "status",
  "usage",
  "upgrade",
  "billing",
  "doctor",
  "update",
  "feedback",
  "mcp",
]);

/**
 * When a non-existent scan path is actually a subcommand name swallowed by an
 * out-of-date CLI, return a hint explaining the real cause. Returns null for a
 * genuine path (including real directories that merely end in a subcommand name,
 * e.g. `packages/mcp`) so normal scans are unaffected.
 */
export function misroutedSubcommandHint(targetPath: string): string | null {
  // Only a bare token (no path separator) is suspect — `./packages/mcp` is a
  // real directory, `mcp` is a misrouted subcommand.
  if (/[/\\]/.test(targetPath)) return null;
  if (!KNOWN_SUBCOMMANDS.has(targetPath)) return null;
  return (
    `'${targetPath}' was read as a path to scan, which means this CLI build has no '${targetPath}' command — it is out of date.\n` +
    `Update it:  npm i -g @vibedrift/cli@latest   (or pin @vibedrift/cli@latest in your MCP config), then retry 'vibedrift ${targetPath}'.`
  );
}

export async function runScan(
  targetPath: string,
  options: ScanOptions,
): Promise<void> {
  const rootDir = canonicalizeRoot(targetPath);

  try {
    const info = await stat(rootDir);
    if (!info.isDirectory()) {
      console.error(`Error: ${rootDir} is not a directory`);
      process.exit(1);
    }
  } catch {
    const hint = misroutedSubcommandHint(targetPath);
    console.error(hint ? `Error: ${hint}` : `Error: ${rootDir} does not exist`);
    process.exit(1);
  }

  // --write-context gate. The .vibedrift/ files (context.md, fix-plan.md,
  // fix-prompts.md, patterns.json) carry the full finding surface — same
  // content a logged-in user sees in the HTML report. Unauthenticated
  // one-shot scans render a brief terminal preview; --write-context would
  // otherwise be a backdoor around that gate. Require a local auth token
  // upfront and error out with a clear login hint. Matches the gate on
  // `vibedrift watch` (which writes the same files on a loop).
  if (options.writeContext) {
    const { resolveToken } = await import("../../auth/resolver.js");
    const token = await resolveToken();
    if (!token) {
      console.error(chalk.red("\n--write-context requires a free account.\n"));
      console.error(chalk.dim("The .vibedrift/ files (context.md, fix-plan.md,"));
      console.error(chalk.dim("fix-prompts.md, patterns.json) carry full finding"));
      console.error(chalk.dim("details — same gate as the one-shot HTML report."));
      console.error("");
      console.error(chalk.yellow("  Sign in (takes 30 seconds, free forever):"));
      console.error(chalk.bold("    vibedrift login"));
      console.error("");
      console.error(chalk.dim("  Or run without the flag for a free one-shot scan:"));
      console.error(chalk.dim(`    vibedrift ${targetPath === "." ? "" : targetPath}`));
      console.error("");
      process.exit(1);
    }
  }

  // Telemetry first-run notice — shown once, persisted in config.
  // Skipped for --local-only and --json (non-interactive).
  if (!options.localOnly && !options.json) {
    try {
      const { showFirstRunNoticeIfNeeded } = await import("../../telemetry/beacon.js");
      await showFirstRunNoticeIfNeeded();
    } catch { /* ignore */ }
  }

  // --local-only gates ALL network calls: auth banner, deep analysis,
  // scan log, fix-prompt synthesis, and the anonymous beacon. The user
  // gets a fully local scan with zero egress.
  // --verbose implies debug logging (env VIBEDRIFT_DEBUG enables it independently).
  if (options.verbose) setDebugEnabled(true);

  const networkEnabled = !options.localOnly;
  const { bearerToken, apiUrl } = networkEnabled
    ? await resolveAuthAndBanner(options)
    : { bearerToken: null, apiUrl: undefined };

  // Signed-in state is independent of network mode. bearerToken is hard-set to
  // null under --local-only (and `vibedrift watch` always scans local-only), so
  // it cannot answer "is this user signed in?". resolveToken() is purely local
  // (flag → env → config file, zero egress), so we can detect a signed-in
  // session without breaking the --local-only zero-egress promise. This drives
  // the tease copy only; every network path stays gated on the real bearerToken.
  // (#64 item 1: a signed-in watch session must not print the sign-in nudge.)
  const signedIn = bearerToken !== null || (await resolveToken()) !== null;

  // Kick off the passive update check as soon as we know the network
  // is allowed. Runs in parallel with the scan so it adds zero latency
  // in the common case (cache hit) and ~200ms worst-case (uncached
  // fetch) which overlaps with analysis time. Respects the same
  // telemetry opt-out as the scan beacon — users who disabled
  // telemetry never ping the registry.
  const updateCheckPromise: Promise<
    import("../../core/update-check.js").UpdateCheckResult | null
  > = (async () => {
    if (!networkEnabled) return null;
    try {
      const { isTelemetryEnabled } = await import("../../telemetry/beacon.js");
      if (!(await isTelemetryEnabled())) return null;
      const { checkForUpdate } = await import("../../core/update-check.js");
      const { getVersion } = await import("../../core/version.js");
      return await checkForUpdate(getVersion());
    } catch {
      return null;
    }
  })();

  const startTime = Date.now();
  // Show spinner for ALL interactive formats (html, terminal, csv, docx).
  // Only suppress for --json (piped to stdout, spinner would corrupt JSON).
  const spinner = !options.json ? ora("Discovering files...").start() : null;

  const pipeline = await runAnalysisPipeline(rootDir, options, spinner);

  const deepTimings = options.deep && bearerToken && networkEnabled
    ? await runDeepAnalysis(pipeline, options, bearerToken, apiUrl, spinner)
    : { timings: {} };

  const timings = { ...pipeline.timings, ...deepTimings.timings };

  const result = await buildScanResult(pipeline, options, startTime, timings, bearerToken, signedIn, apiUrl, spinner);

  // Persist the RepoDriftBaseline as a scan side-effect so the MCP server's
  // cold start is a fast load rather than a 3–8s rebuild. Reuses the ctx +
  // drift findings already computed by the pipeline (only the function-
  // signature pass is added). Tied to the same cache toggle as findings-cache;
  // local-only (no network); best-effort — a failure here must never break a
  // scan, so it's wrapped and only surfaced under --verbose.
  if (options.cache !== false && !isCacheDisabled()) {
    try {
      const { assembleBaseline, writeBaseline } = await import("../../core/baseline.js");
      await writeBaseline(assembleBaseline(rootDir, pipeline.ctx, pipeline.driftResult.driftFindings));
      if (options.verbose) console.error("[baseline] wrote MCP drift baseline");
    } catch (err) {
      if (options.verbose) console.error(`[baseline] skipped: ${(err as Error).message ?? err}`);
    }
  }

  // Resolve the update check before rendering. The check was kicked off
  // at scan start so by now it's almost always already resolved from
  // cache; worst case we wait a fraction of a second for the registry
  // response. Errors are swallowed inside checkForUpdate — we just get
  // null and skip rendering.
  result.updateCheck = await updateCheckPromise;

  // Fix prompts are a paid feature (Pro). Resolve the plan from cached
  // config and gate every fix-prompt surface on it; the /v1/fix-prompts route is
  // the authoritative server backstop. Defaults to free-gating on any error, and
  // works offline / --local-only (cached plan, no network call).
  let paid = false;
  let plan: import("../../auth/plan.js").Plan | undefined;
  try {
    const { readConfig } = await import("../../auth/config.js");
    const { isPaidPlan } = await import("../../auth/plan.js");
    plan = (await readConfig()).plan as import("../../auth/plan.js").Plan | undefined;
    paid = isPaidPlan(plan);
  } catch { /* default: free-gated */ }

  // Rich fix-prompt prose synthesis (PAID). An Anthropic call (~15-20s) whose
  // prose feeds the .vibedrift files, the HTML report, and the dashboard report
  // (never the terminal summary). For --write-context we MUST synthesize here,
  // before writeContextIfRequested writes the files below. Every other authed
  // path runs it later — behind a loader after the summary (see logAndRender) —
  // so it never delays the result the user sees.
  if (bearerToken && networkEnabled && paid && options.writeContext) {
    try {
      const { synthesizeFixPrompts } = await import("../../ml-client/fix-prompts.js");
      await synthesizeFixPrompts(result.findings, result.context, {
        token: bearerToken,
        apiUrl,
        verbose: options.verbose,
      });
      (result as ScanResultAugmented).__fixPromptsDone = true;
    } catch (err) {
      if (options.verbose) console.error(`[fix-prompts] skipped: ${(err as Error).message ?? err}`);
    }
  }

  // Coherence report — the deep-scan hero. PAID-ONLY, and only on a deep scan
  // (it synthesizes the deep findings + drift into a ranked audit). The server
  // route is require_paid; this client-side gate avoids a guaranteed 402 round
  // trip for free plans. Best-effort: a null report just renders nothing.
  if (options.deep && bearerToken && networkEnabled && paid) {
    try {
      const targetUrl = apiUrl ?? (await resolveApiUrl(options.apiUrl));
      const { fetchCoherenceReport } = await import("../../ml-client/coherence.js");
      const report = await fetchCoherenceReport(result, targetUrl, bearerToken);
      if (report) result.coherenceReport = report;
      if (options.verbose && report) {
        console.error(`[coherence] grade ${report.coherenceGrade}, ${report.rankedIssues.length} ranked issues`);
      }
    } catch (err) {
      if (options.verbose) console.error(`[coherence] skipped: ${(err as Error).message ?? err}`);
    }
  }

  // Anonymous scan beacon — fires on every scan unless telemetry is
  // disabled or --local-only is set. Best-effort, never delays the scan.
  if (networkEnabled) {
    try {
      const { sendScanBeacon, buildScanBeaconPayload } = await import("../../telemetry/beacon.js");
      const { getVersion } = await import("../../core/version.js");
      void sendScanBeacon(
        buildScanBeaconPayload(result, { cliVersion: getVersion(), isDeep: !!options.deep, authed: !!bearerToken }),
        apiUrl,
      );
    } catch { /* never block the scan */ }
  }

  // One-time "scoring refined" notice. When our scoring methodology changes
  // between releases, users stay agnostic of internal versions — there is NO
  // per-scan version banner. We show a single low-noise line linking the
  // release notes, then record the version so it never repeats. Skipped for
  // --json (machine output) and brand-new users (nothing to re-align). Reads
  // the prior scan BEFORE saveScanResult below, and touches only local config
  // (no network). Best-effort — never blocks the scan.
  if (!options.json) {
    try {
      const { readConfig, patchConfig } = await import("../../auth/config.js");
      const { shouldShowScoringNotice, scoringNoticeLine } = await import("../../core/scoring-notice.js");
      const cfg = await readConfig();
      const prior = await loadLatestScan(rootDir); // current scan not yet saved
      if (
        shouldShowScoringNotice({
          lastSeen: cfg.lastSeenScoringVersion,
          current: SCORING_VERSION,
          hasPriorHistory: prior != null,
        })
      ) {
        console.error("");
        console.error(chalk.dim(`  ℹ ${scoringNoticeLine()}`));
      }
      if (cfg.lastSeenScoringVersion !== SCORING_VERSION) {
        await patchConfig({ lastSeenScoringVersion: SCORING_VERSION });
      }
    } catch {
      /* notice is best-effort — never block the scan */
    }
  }

  // Save history (per-project, in user home dir — not in the project itself).
  // Persisting `scoringVersion` lets future scans detect that this scan was
  // computed under a different formula and skip cross-version deltas.
  //
  // Save using the scored (rendered) drift view so the persisted scan matches
  // the diff digest the scan-over-scan comparison computes from the same view.
  // A below-floor advisory finding therefore never shows as a spurious
  // "new/resolved drift finding". The baseline (assembleBaseline) still reads
  // the raw representation.
  await saveScanResult(
    rootDir,
    result.scores,
    result.compositeScore,
    result.hygieneScores,
    result.hygieneScore,
    result.findings,
    result.driftFindings,
    result.scoringVersion,
  );

  await writeContextIfRequested(result, options, rootDir, paid);

  await logAndRender(result, options, bearerToken, apiUrl, rootDir, pipeline.codeDnaResult, paid, plan);
}
