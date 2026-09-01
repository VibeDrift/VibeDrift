import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { symlink, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  waitForWatchEvent,
  probeRecursiveWatchLiveness,
  __test_snapshotMtimes,
} from "../../../src/cli/commands/watch.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const dirs: string[] = [];
function tracked(prefix: string): string {
  const d = tmp(prefix);
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// waitForWatchEvent — the pure wait/timeout decision, decoupled from any
// real filesystem watcher.
// ────────────────────────────────────────────────────────────────────
describe("waitForWatchEvent", () => {
  it("resolves true as soon as a matching event arrives", async () => {
    let emit: ((n: number) => void) | null = null;
    const promise = waitForWatchEvent<number>(
      (onEvent) => {
        emit = onEvent;
        return () => { emit = null; };
      },
      (n) => n === 42,
      1000,
    );
    // Non-matching event first — must not resolve.
    emit!(1);
    emit!(42);
    await expect(promise).resolves.toBe(true);
    // unsubscribe was called on the matching resolution.
    expect(emit).toBeNull();
  });

  it("resolves false when nothing matches before the timeout", async () => {
    const promise = waitForWatchEvent<number>(
      () => () => {},
      () => false,
      20,
    );
    await expect(promise).resolves.toBe(false);
  });

  it("unsubscribes on timeout too", async () => {
    let unsubscribed = false;
    await waitForWatchEvent<number>(
      () => () => { unsubscribed = true; },
      () => false,
      10,
    );
    expect(unsubscribed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// probeRecursiveWatchLiveness — regression guard for the watch.ts:192 P1:
// fs.watch(root, { recursive: true }) can be silently accepted while only
// watching the top level, so subdirectory edits are never reported and the
// promised poll fallback never engages. The probe must detect that case.
// ────────────────────────────────────────────────────────────────────
describe("probeRecursiveWatchLiveness", () => {
  /** Minimal fake matching the subset of FSWatcher the probe uses. */
  function fakeWatcher() {
    let listener: ((event: string, filename: string) => void) | null = null;
    return {
      handle: {
        on: (_event: "change", cb: (event: string, filename: string) => void) => { listener = cb; },
        off: (_event: "change", cb: (event: string, filename: string) => void) => {
          if (listener === cb) listener = null;
        },
      },
      /** Fire a change event once a listener is armed (polls briefly). */
      async emitWhenArmed(filename: string): Promise<void> {
        for (let i = 0; i < 100 && !listener; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        listener?.("change", filename);
      },
    };
  }

  it("resolves true when the watcher reports the nested probe file", async () => {
    const rootDir = tracked("vd-watch-probe-live-");
    const w = fakeWatcher();

    const resultPromise = probeRecursiveWatchLiveness(rootDir, w.handle as any, 3000);

    // Discover the exact throwaway filename the probe wrote, then report it
    // back through the fake watcher — mirroring a real recursive fs.watch
    // that correctly saw the nested change.
    const probeDir = join(rootDir, ".vibedrift-watch-probe");
    let filename: string | undefined;
    for (let i = 0; i < 100 && !filename; i++) {
      try {
        const files = await readdir(probeDir);
        if (files.length > 0) filename = files[0];
      } catch {
        // directory not created yet
      }
      if (!filename) await new Promise((r) => setTimeout(r, 20));
    }
    expect(filename).toBeDefined();
    await w.emitWhenArmed(join(probeDir, filename!));

    await expect(resultPromise).resolves.toBe(true);
  });

  it("resolves false when the watcher never reports the change (top-level-only watch)", async () => {
    const rootDir = tracked("vd-watch-probe-dead-");
    const w = fakeWatcher();
    // Never call emitWhenArmed — simulates a watcher that silently only
    // covers rootDir itself and never reports the nested write.
    const result = await probeRecursiveWatchLiveness(rootDir, w.handle as any, 150);
    expect(result).toBe(false);
  });

  it("cleans up the probe directory afterward either way", async () => {
    const rootDir = tracked("vd-watch-probe-cleanup-");
    const w = fakeWatcher();
    await probeRecursiveWatchLiveness(rootDir, w.handle as any, 100);
    const entries = await readdir(rootDir).catch(() => []);
    expect(entries).not.toContain(".vibedrift-watch-probe");
  });
});

// ────────────────────────────────────────────────────────────────────
// snapshotMtimes — regression guard for watch.ts:289 P2: the polling walk
// used stat() (follows symlinks) with no cycle guard, so a symlink loop
// (a directory symlinked back to one of its own ancestors) recursed
// forever. lstat + skipping symlinks closes it.
// ────────────────────────────────────────────────────────────────────
describe("snapshotMtimes — symlink safety", () => {
  it("does not hang on a directory symlink cycle", async () => {
    const rootDir = tracked("vd-watch-symlink-");
    const sub = join(rootDir, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "real.txt"), "hello");

    let symlinksSupported = true;
    try {
      // sub/loop -> rootDir (a cycle: walking into sub/loop would re-enter
      // rootDir, then sub, then sub/loop again, forever, under stat()).
      await symlink(rootDir, join(sub, "loop"), "junction");
    } catch {
      // No symlink privilege on this machine/OS (common on Windows without
      // Developer Mode). Nothing to regress-test here; skip gracefully.
      symlinksSupported = false;
    }
    if (!symlinksSupported) return;

    const snapshotPromise = __test_snapshotMtimes(rootDir);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const result = await Promise.race([snapshotPromise, timeout]);

    expect(result).not.toBe("timeout");
    const snapshot = result as Map<string, number>;
    expect(snapshot.has("sub/real.txt")).toBe(true);
    // The symlink itself must never be walked into or recorded as a file.
    for (const key of snapshot.keys()) {
      expect(key).not.toContain("loop");
    }
  });
});
