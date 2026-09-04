/**
 * vibedrift-hook: the thin session-event entrypoint that agent hooks invoke.
 *
 * Contract (Phase 1, passive only):
 * - reads ONE hook JSON payload from stdin;
 * - normalizes it, masks secrets, appends it to the session ledger;
 * - on edit events (and, after a Bash call, on the files it changed), runs
 *   the inline drift checks and, when there is an un-cooled advisory, prints
 *   it to stderr and exits 2 (PostToolUse feeds stderr into the agent's
 *   context without blocking the tool);
 * - exits 0 in EVERY other circumstance: malformed input, unknown events,
 *   missing baseline, internal errors, timeout. A hook failure must never
 *   interrupt the user's agent.
 *
 * Only Node built-ins are imported statically, so the self-timeout arms before
 * any heavy module is evaluated; the workhorse (src/session/hook-main.ts, and
 * the ledger, checks and baseline loader it pulls) is dynamically imported
 * inside the guarded run. This entry deliberately avoids Commander (measured
 * ~1.1s CLI entry vs ~0.2s here). It does transitively pull the baseline
 * loader and the AST function extractor, but the tree-sitter WASM parser is
 * never initialized on this path (no file is parsed), so the cold cost stays
 * ~60-80ms.
 *
 * argv: `--source=plugin` marks a run started by the Claude Code plugin's
 * hooks (see hooks/hooks.json); hook-main.ts documents what that changes.
 */

const SELF_TIMEOUT_MS = 2000;

// Arm the fail-open guard first, before the dynamic import below runs.
const timer = setTimeout(() => {
  if (process.env.VIBEDRIFT_HOOK_DEBUG === "1") process.stderr.write("[vibedrift-hook] self-timeout\n");
  process.exit(0);
}, SELF_TIMEOUT_MS);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const raw = await readStdin();
  const { runHook } = await import("./hook-main.js");
  return runHook(raw, process.argv.slice(2));
}

main()
  .then((code) => {
    clearTimeout(timer);
    process.exit(code);
  })
  .catch((err: unknown) => {
    clearTimeout(timer);
    if (process.env.VIBEDRIFT_HOOK_DEBUG === "1") {
      process.stderr.write(`[vibedrift-hook] error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exit(0);
  });

// A module, not a script: with no static import above, TypeScript would
// otherwise treat this file as a global script and its `main` would collide
// with the other bundle entries' (session-flush.ts).
export {};
