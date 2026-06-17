/**
 * validate_change — would a proposed/changed function drift from the repo, or
 * duplicate something that already exists? Composition of the drift and
 * duplicate signals against the cached baseline; the one tool that judges code
 * the agent hasn't committed yet.
 *
 * v1 scope (honest): conflict detection covers ASYNC patterns (via the shared
 * classifier, so it can never disagree with the async detector) plus the
 * duplicate check. Other dimensions need a single-body classifier per detector
 * and land with the deferred delta-aware vote.
 */
import { z } from "zod";
import { relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DriftCategory } from "../../drift/types.js";
import type { RepoDriftBaseline } from "../../core/baseline.js";
import type { IntentHint } from "../../intent/types.js";
import { getBaseline } from "../baseline-provider.js";
import { classifyAsyncStyle, ASYNC_STYLE_NAMES, type AsyncStyle } from "../../drift/async-style.js";
import { classifyReturnShapeLabel, SHAPE_NAMES } from "../../drift/return-shape-consistency.js";
import { classifyDataAccessLabel, DATA_ACCESS_NAMES } from "../../drift/architectural-contradiction.js";
import { findSimilarToBody, type SimMatch } from "../../codedna/find-similar-to-body.js";
import { noBaselineResult, type Status } from "../envelope.js";
import { finalizeMcpResult } from "../nudge.js";
import { deepAnalyze, bodyToPayloads, inferLanguage, degradeMessage, type DeepResult } from "../deep-client.js";

const DUPLICATE_THRESHOLD = 0.8; // a CHANGE introducing a near-clone — stricter than discovery
const MAX_MATCHES = 20;
const THIN_MARGIN = 75; // consistencyScore near the 70% dominance bar → low confidence

const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  targetPath: z.string().describe("Path of the file being changed (absolute, or relative to rootDir)"),
  body: z.string().describe("The proposed/changed function body (source)"),
  deep: z
    .boolean()
    .optional()
    .describe(
      "Opt-in cloud deep check (Pro/Team): runs CodeRankEmbed intent-mismatch + Claude-validated semantic-duplicate detection on this function via the API. Costs 1/50 of a deep scan, hourly-capped. Use when finalizing a non-trivial function or when the local check is ambiguous — not on every edit.",
    ),
};

export interface Conflict {
  dimension: DriftCategory;
  dominantPattern: string;
  yourPattern: string;
  fixHint: string;
}

export interface ValidateChangeResult {
  ok: boolean;
  conflicts: Conflict[];
  duplicateOf: SimMatch[];
  referenceFiles: string[];
  confidence: "high" | "low";
}

// Intent-hint `pattern` values use "then_chain" (singular); AsyncStyle uses
// "then_chains". Map declared patterns onto the classifier's vocabulary.
const HINT_TO_ASYNC_STYLE: Record<string, AsyncStyle> = {
  async_await: "async_await",
  then_chains: "then_chains",
  then_chain: "then_chains",
};

/** Highest-confidence declared hint for a category (intent hints can conflict —
 *  e.g. a real rule at confidence 0.7 vs a detector-list mention at 0.5 — so the
 *  strongest declaration wins). */
function topHintFor(hints: IntentHint[], category: DriftCategory): IntentHint | null {
  let best: IntentHint | null = null;
  for (const h of hints) {
    if (h.category !== category) continue;
    if (!best || h.confidence > best.confidence) best = h;
  }
  return best;
}

interface EffectiveDominant {
  display: string; // a canonical pattern display name for the dimension
  source: "vote" | "declared";
  refFiles: string[];
  cite?: string; // "CLAUDE.md:101" when declared
}

interface DimensionCheck {
  dimension: DriftCategory;
  labels: Set<string>; // the canonical display labels this dimension can produce
  classify: (body: string, relTarget: string) => string | null; // the body's display label, or null
  hintDisplay: (hint: IntentHint) => string | null; // a declared hint's display label, or null
}

/** A declared hint's display label for a dimension: its `label` when already a
 *  canonical display name, else its `pattern` key mapped through the names map.
 *  Returns null when the declaration isn't in this dimension's vocabulary. */
function labelFromHint(hint: IntentHint, labels: Set<string>, names: Record<string, string>): string | null {
  if (labels.has(hint.label)) return hint.label;
  const byKey = names[hint.pattern];
  return byKey && labels.has(byKey) ? byKey : null;
}

/** The dimensions a proposed body is validated against. Each pairs a single-body
 *  classifier (the SAME one its detector uses) with the dimension's canonical
 *  label set, so the in-loop check can never disagree with the detector. v1
 *  covered async only; this adds return-shape (throws vs Result vs sentinels)
 *  and data-access (raw SQL / direct db / ORM / repository / http). */
const DIM_CHECKS: DimensionCheck[] = [
  {
    dimension: "async_patterns",
    labels: new Set([ASYNC_STYLE_NAMES.async_await, ASYNC_STYLE_NAMES.then_chains]),
    classify: (body) => {
      const s = classifyAsyncStyle(body);
      return s && s !== "mixed" ? ASYNC_STYLE_NAMES[s] : null;
    },
    hintDisplay: (h) => {
      const s = HINT_TO_ASYNC_STYLE[h.pattern];
      return s ? ASYNC_STYLE_NAMES[s] : null;
    },
  },
  {
    dimension: "return_shape_consistency",
    labels: new Set(Object.values(SHAPE_NAMES)),
    classify: (body) => classifyReturnShapeLabel(body),
    hintDisplay: (h) => labelFromHint(h, new Set(Object.values(SHAPE_NAMES)), SHAPE_NAMES),
  },
  {
    dimension: "architectural_consistency",
    labels: new Set(Object.values(DATA_ACCESS_NAMES)),
    classify: (body, relTarget) => classifyDataAccessLabel(body, relTarget),
    hintDisplay: (h) => labelFromHint(h, new Set(Object.values(DATA_ACCESS_NAMES)), DATA_ACCESS_NAMES),
  },
];

/** The dominant to validate against for a dimension: the detector vote when it
 *  established one IN THIS dimension's vocabulary, ELSE the team's declared
 *  convention (highest-confidence intent hint). The declared fallback is what
 *  catches the FIRST deviation in a fully-consistent dimension (no finding, so
 *  no vote, but the rule is binding). Note architectural_consistency is a
 *  COMPOSITE category — its stored vote may be a DI label, not data-access — so
 *  the vote is only honored when it's actually a data-access label; otherwise
 *  the declared ORM/repository rule stands in. */
function effectiveDominant(baseline: RepoDriftBaseline, check: DimensionCheck): EffectiveDominant | null {
  const vote = baseline.perCategoryVote[check.dimension];
  if (vote && check.labels.has(vote.dominantPattern)) {
    return { display: vote.dominantPattern, source: "vote", refFiles: vote.dominantFiles };
  }
  const hint = topHintFor(baseline.intentHints ?? [], check.dimension);
  if (hint) {
    const display = check.hintDisplay(hint);
    if (display) return { display, source: "declared", refFiles: [], cite: `${hint.source}:${hint.line}` };
  }
  return null;
}

/** Pure: validate a proposed body against the frozen baseline. `relTarget` is
 *  the change's file relative to the repo root — its own functions are excluded
 *  from the duplicate check so editing a function isn't flagged against itself. */
export function validateChange(
  baseline: RepoDriftBaseline,
  relTarget: string,
  body: string,
): ValidateChangeResult {
  const conflicts: Conflict[] = [];

  // For each dimension we can classify a single body in: find the dominant
  // (detector vote, else declared rule), classify the proposed body with the
  // SAME classifier the detector uses, and flag a conflict when they differ.
  // The classifier returns the dimension's DISPLAY label, matching what the
  // vote stores, so the comparison is apples-to-apples.
  for (const check of DIM_CHECKS) {
    const dom = effectiveDominant(baseline, check);
    if (!dom) continue;
    const mine = check.classify(body, relTarget);
    if (!mine || mine === dom.display) continue;
    const where =
      dom.source === "declared" ? ` (declared in ${dom.cite})` : dom.refFiles[0] ? ` See ${dom.refFiles[0]}.` : "";
    conflicts.push({
      dimension: check.dimension,
      dominantPattern: dom.display,
      yourPattern: mine,
      fixHint: `Repo uses ${dom.display}; this change uses ${mine}.${where}`,
    });
  }

  const index = baseline.minhashIndex.filter((e) => e.relativePath !== relTarget);
  const duplicateOf = findSimilarToBody(body, index, { threshold: DUPLICATE_THRESHOLD, cap: MAX_MATCHES });

  const referenceFiles = conflicts.length
    ? (baseline.perCategoryVote[conflicts[0].dimension]?.dominantFiles ?? []).slice(0, 3)
    : [];

  // Low confidence when the dimension we judged is itself only weakly dominant
  // (near the 70% bar) — a frozen-baseline vote can't see the proposed change
  // tipping the balance. A declared-rule fallback (no vote) is binding, so it
  // stays high. Honest hedge per the deferred delta-vote.
  const judgedVote = conflicts.length
    ? baseline.perCategoryVote[conflicts[0].dimension]
    : baseline.perCategoryVote.async_patterns;
  const confidence: "high" | "low" =
    judgedVote && judgedVote.consistencyScore < THIN_MARGIN ? "low" : "high";

  return {
    ok: conflicts.length === 0 && duplicateOf.length === 0,
    conflicts,
    duplicateOf,
    referenceFiles,
    confidence,
  };
}

export interface ValidateChangeOut extends ValidateChangeResult {
  status: Status;
  message?: string;
  // Present only when `deep: true` was requested. Carries the cloud findings
  // (intent mismatch + Claude-validated duplicates) or a degraded marker.
  deep?: DeepResult;
}

export async function run({
  rootDir,
  targetPath,
  body,
  deep,
}: {
  rootDir: string;
  targetPath: string;
  body: string;
  deep?: boolean;
}): Promise<ValidateChangeOut> {
  const { baseline, status } = await getBaseline(rootDir);
  if (!baseline) {
    return noBaselineResult({ ok: true, conflicts: [], duplicateOf: [], referenceFiles: [], confidence: "low" })
      .structuredContent as unknown as ValidateChangeOut;
  }
  const relTarget = relative(rootDir, resolve(rootDir, targetPath));
  const out: ValidateChangeOut = { status, ...validateChange(baseline, relTarget, body) };

  if (!deep) return out;

  // Opt-in deep pass. The local tool is free for everyone; the deep check is
  // metered — the API re-checks entitlement + billing server-side and the
  // client degrades gracefully (never throws) when the budget is empty.
  const deepRes = await deepAnalyze(bodyToPayloads(body, relTarget), inferLanguage(relTarget));
  out.deep = deepRes;
  if (deepRes.degraded) {
    out.status = "degraded";
    out.message = degradeMessage(deepRes.reason);
    return out;
  }
  const deepHits = deepRes.intentMismatches.length + deepRes.duplicates.length;
  if (deepHits > 0) {
    out.ok = false;            // cloud found real drift the local pass can't see
    out.status = "partial";    // local + deep both contributed
    out.confidence = "high";
  }
  return out;
}

export const registerValidateChange = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "validate_change",
      {
        title: "Validate a proposed change",
        description:
          "After proposing or writing a function, validate it against the repo's patterns before committing. Returns ok=true/false plus any new drift the change would introduce (with fix hints + reference files) and any existing function it would duplicate. Local; needs a prior `vibedrift scan`.",
        inputSchema,
      },
      // Write-time tool: may carry the deep-scan nudge; a successful deep pass
      // resets the nudge clock.
      async (args) => finalizeMcpResult(await run(args), { nudge: true }),
    );
  },
};
