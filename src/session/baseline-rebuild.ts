/**
 * Detached baseline rebuild (Stop-hook path). Spawned by the hook when a
 * session has written code the persisted baseline has never seen and enough
 * time has passed since the last rebuild; runs a full `buildBaseline` and
 * persists it, so the next session's inline checks compare against a tree
 * that includes what this one wrote.
 *
 * argv: <rootDir>. Exits 0 on every outcome (the hook never waits for it, and
 * a failed rebuild only means the next checks keep using the old baseline).
 * Fully detached and unref'd by the parent, exactly like session-flush.js.
 */

import { buildBaseline, writeBaseline } from "../core/baseline.js";

async function main(): Promise<void> {
  const [, , rootDir] = process.argv;
  if (!rootDir) return;
  try {
    const b = await buildBaseline(rootDir);
    await writeBaseline(b);
  } catch {
    // fail-open: the old baseline stays
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);

export {};
