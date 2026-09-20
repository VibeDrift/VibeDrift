/**
 * The SessionStart activation nudge (L-N3 / L-N8).
 *
 * When a repo is un-activated, the hook injects a one-time instruction into the
 * model's context asking the human, in plain language, whether to enable Drift
 * Sessions here. The relay is best-effort (the model may not surface it); the
 * FIRING is deterministic. Verified against Claude Code 2.1.216:
 *
 * - A hook injects model-visible context by printing
 *   `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`
 *   to stdout. `additionalContext` is model-visible, not shown verbatim.
 * - The deterministic USER-visible channel is the top-level `systemMessage`
 *   field (exit-0 stderr is ignored; exit 2 blocks — neither is usable here).
 * - SessionStart stdin carries `source` ∈ {startup, resume, clear, compact}.
 *
 * L-N8 budget: ask at most once per genuinely NEW interactive session
 * (`source` ∈ {startup, clear}); never on resume/compact; never in a
 * non-interactive/headless context; at most ASK_BUDGET times, then an implicit
 * decline is recorded and a one-line breadcrumb is shown. No per-turn
 * re-injection — this fires on SessionStart only.
 *
 * This module is pure (classifiers + string builders); hook-entry supplies the
 * effects (activation store read, budget consume, stdout write).
 */

import type { SessionEntitlement } from "./entitlement.js";
import type { TrialRecapTotals } from "./trial-recap.js";

/** The four documented Claude Code SessionStart `source` values. */
export type StartSource = "startup" | "resume" | "clear" | "compact";

/** A genuinely new interactive session that may consume one ask. `resume` and
 *  `compact` are continuations of an existing session and never re-ask. */
export function isNewInteractiveSource(source: string | undefined): boolean {
  return source === "startup" || source === "clear";
}

/** Deterministic non-interactive signal: the plugin / CI sets this on headless
 *  invocations so an unattended run never asks or burns the ask budget. Kept as
 *  an explicit env override rather than an inferred entrypoint value — the
 *  latter needs a confirming payload capture and is a follow-up (see todo). */
export function isNonInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.VIBEDRIFT_HOOK_NONINTERACTIVE;
  return v === "1" || v === "true";
}

export interface NudgeOutput {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
  /** One-line user-visible notice (trial count / breadcrumb). */
  systemMessage?: string;
}

export interface NudgeContext {
  repoName: string;
  /** Present when the account is on the free trial — drives the honest
   *  "session N of 5" line so trial usage is never invisible (L-N4). */
  entitlement?: SessionEntitlement | null;
  /** True on the final (budget-exhausting) ask: fold in the breadcrumb. */
  lastAsk?: boolean;
  /** The folder this repo sits in, when granting it is allowed (the hook
   *  resolves and validates it; $HOME, anything above it and a filesystem root
   *  are refused outright). Present means the ask leads with "every repo under
   *  this folder"; absent means the ask is about this repo alone, as before. */
  grantDir?: string | null;
}

const BREADCRUMB =
  "VibeDrift won't ask again in this repo — run `vibedrift enable` or `vibedrift decline` to set it explicitly.";

/**
 * The one-line trial meter, shared by the nudge path (un-activated repos) and
 * the activated-repo SessionStart notice. Null unless the CACHED entitlement
 * explicitly says trial: an unknown or unreadable cache emits nothing (a
 * fabricated count is worse than silence), and Pro never sees a meter.
 *
 * Boundary notice: the metrics-surface plan asked for an end-of-session-4
 * banner, but Claude Code has no reliable session-end signal (B6: Stop fires
 * per response, and SessionEnd is unobserved on /resume), so the START of the
 * final session (trialUsed at limit - 1) is the honest boundary.
 */
export function buildTrialLine(e: SessionEntitlement | null | undefined): string | null {
  if (!e || !e.entitled || e.reason !== "trial") return null;
  // A spent (or corrupt, "6 of 5") count never renders: the lock notice owns
  // the spent state, and a grandfathered in-flight cache must not show a meter.
  if (e.trialUsed >= e.trialLimit) return null;
  const line = `VibeDrift trial: ${e.trialUsed} of ${e.trialLimit} sessions used.`;
  return e.trialUsed === e.trialLimit - 1 ? `${line} This is your last free session.` : line;
}

/**
 * The model-facing relay instruction. Imperative (relays reliably in testing)
 * and carries the soft-decline path (N1: the concierge skill formalizes it in
 * N2; until then it rides here).
 *
 * When a grantable folder is known the ask LEADS with it, because per-repo
 * consent is the setup work people forget: one yes for the folder covers every
 * repo in it, including the ones that do not exist yet, so nothing ever asks
 * again. The folder answer is deliberately NOT something the agent can do on
 * the user's behalf — `vibedrift enable --dir` shows the resolved path and
 * takes a typed confirmation, which is the whole guard on a grant that broad,
 * so the instruction hands that one to the person. The narrower "just this
 * repo" answer stays a tool call, exactly as before.
 */
export function buildNudgeInstruction(ctx: NudgeContext): string {
  const trialLine =
    ctx.entitlement && ctx.entitlement.reason === "trial"
      ? ` The user is on the free trial (${ctx.entitlement.trialUsed} of ${ctx.entitlement.trialLimit} sessions used); mention that enabling starts a monitored session.`
      : "";
  const question = ctx.grantDir
    ? `  "Want VibeDrift to watch every repo under ${ctx.grantDir} for drift, or just this one?"`
    : `  "Want me to enable VibeDrift live drift monitoring for this repo?"`;
  const folderOption = ctx.grantDir
    ? [
        `- If they want the whole folder: tell them to run \`vibedrift enable --dir ${ctx.grantDir}\` in their terminal. It prints the folder and asks them to confirm, so only they can grant it — you cannot do this one for them. Nothing there is ever asked again.`,
        `- If they want just this repo: call the VibeDrift \`enable\` tool for this repo, then continue.`,
      ]
    : [`- If they say yes: call the VibeDrift \`enable\` tool for this repo, then continue.`];
  return [
    `VibeDrift is installed but NOT active in this repository ("${ctx.repoName}").`,
    `Before starting the user's task, ask them once, in plain language:`,
    question,
    ...folderOption,
    `- If they say no or "not now": call \`enable\` with {"decline": true} so this is not asked again.`,
    `- If they ignore the question or just restate their task: treat that as "not now" and call \`enable\` with {"decline": true} — do not keep asking.`,
    `Never enable anything without an explicit yes.${trialLine}`,
  ].join("\n");
}

/** A user-visible-only hook output: no model-facing instruction attached. */
export interface NoticeOutput {
  systemMessage: string;
}

/**
 * The paywall signal for the native path. `watch-session` has a full lock
 * screen; the native flow has no terminal we own, so the honest equivalent is
 * one `systemMessage` line on SessionStart.
 *
 * Honesty constraints (§6): state that recording is paused, then recap only
 * what the REAL local ledgers show (`totals`, summed by trial-recap). The copy
 * is machine-scoped, never trial-scoped: local ledgers can hold more or fewer
 * sessions than the trial consumed (fail-open captures, other machines).
 * Three tiers: real numbers when drift was caught; "ran clean" only when every
 * ledger was read in full; otherwise no claim at all (a partial or absent read
 * can support neither story). Never claim anything was prevented, blocked, or
 * deleted: the local ledgers are untouched and still the user's.
 */
export function buildLockNotice(ctx: {
  entitlement: SessionEntitlement;
  totals?: TrialRecapTotals | null;
}): NoticeOutput {
  const limit = ctx.entitlement.trialLimit;
  const t = ctx.totals;
  let recap: string;
  if (t && t.flagged > 0) {
    const drifts = t.flagged === 1 ? "1 drift" : `${t.flagged} drifts`;
    const fixed =
      t.resolved === 0
        ? "none were fixed in-session."
        : `your agent fixed ${t.resolved} on the spot, re-verified.`;
    recap = `On this machine, VibeDrift flagged ${drifts}; ${fixed} Keep it in the loop: Pro, $15/mo. vibedrift.ai/dashboard/billing`;
  } else if (t && t.complete) {
    recap = `Your watched sessions on this machine ran clean. Pro keeps the watch on: $15/mo. vibedrift.ai/dashboard/billing`;
  } else {
    recap = `Keep it in the loop: Pro, $15/mo. vibedrift.ai/dashboard/billing`;
  }
  return {
    systemMessage:
      `VibeDrift: your ${limit}-session trial is used up, so this session is not being recorded. ` + recap,
  };
}

/** Build the stdout object the hook prints on a nudging SessionStart. */
export function buildNudgeOutput(ctx: NudgeContext): NudgeOutput {
  const out: NudgeOutput = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildNudgeInstruction(ctx),
    },
  };
  const trialLine = buildTrialLine(ctx.entitlement);
  if (ctx.lastAsk) out.systemMessage = BREADCRUMB;
  else if (trialLine) out.systemMessage = trialLine;
  return out;
}
