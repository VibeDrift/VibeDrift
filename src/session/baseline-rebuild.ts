/**
 * Detached baseline builder (Stop-hook path). Spawned by the hook for the repos
 * a session touched that need their patterns (re)learned: one that has no
 * baseline at all, and one whose baseline never saw what this session wrote.
 * Runs a full `buildBaseline` per repo and persists it, so the next session's
 * inline checks compare against a tree that includes this one's work.
 *
 * argv: <rootDir> [<rootDir>...]. A session can span several repos, and they
 * are built ONE AT A TIME on purpose: each build is a full scan, and running
 * them in parallel would turn a quiet background task into a CPU spike on the
 * machine the person is still working on. A repo that fails is skipped and the
 * next one still runs.
 *
 * Exits 0 on every outcome (the hook never waits for it, and a failed build
 * only means the next checks keep using what is already there). Fully detached
 * and unref'd by the parent, exactly like session-flush.js.
 */

import { buildBaseline, writeBaseline } from "../core/baseline.js";

async function main(): Promise<void> {
  const roots = process.argv.slice(2).filter((r) => r.length > 0);
  for (const rootDir of roots) {
    try {
      const b = await buildBaseline(rootDir);
      await writeBaseline(b);
    } catch {
      // fail-open: this repo keeps what it had; the rest still build
    }
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);

export {};
