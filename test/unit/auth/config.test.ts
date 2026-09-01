import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * src/auth/config.ts resolves its config path from vibedriftHome() at
 * module load time, so every test redirects VIBEDRIFT_HOME to a fresh
 * temp dir and vi.resetModules() + dynamic-imports the module so the
 * path constant re-resolves against it. Mirrors the pattern in
 * test/unit/core/update-check.test.ts.
 */

describe("auth/config", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "vd-auth-config-"));
    origHome = process.env.VIBEDRIFT_HOME;
    process.env.VIBEDRIFT_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.VIBEDRIFT_HOME = origHome;
    else delete process.env.VIBEDRIFT_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("readConfig on a missing file returns {} without throwing", async () => {
    const { readConfig, getConfigPath } = await import("../../../src/auth/config.js");
    const result = await readConfig();
    expect(result).toEqual({});
    expect(getConfigPath()).toContain(tmpHome);
  });

  it("readConfig on corrupt JSON warns to stderr and returns {} instead of throwing", async () => {
    const { readConfig, writeConfig, getConfigPath } = await import("../../../src/auth/config.js");
    // Seed a valid config first so the file + dir exist, then corrupt it.
    await writeConfig({ token: "t" });
    const { writeFile } = await import("fs/promises");
    await writeFile(getConfigPath(), "{ not valid json", "utf-8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await readConfig();
      expect(result).toEqual({});
      expect(stderrSpy).toHaveBeenCalled();
      const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes("unreadable"));
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("writeConfig persists the config and restricts it to owner read/write", async () => {
    const { writeConfig, readConfig, getConfigPath } = await import("../../../src/auth/config.js");
    await writeConfig({ token: "abc123", plan: "pro" });

    const roundTripped = await readConfig();
    expect(roundTripped.token).toBe("abc123");
    expect(roundTripped.plan).toBe("pro");

    // Windows doesn't enforce POSIX mode bits (chmod is best-effort there —
    // see the try/catch in writeConfig), so only assert 0600 on POSIX.
    if (process.platform !== "win32") {
      const st = await stat(getConfigPath());
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it("patchConfig merges without clobbering unrelated fields", async () => {
    const { writeConfig, patchConfig, readConfig } = await import("../../../src/auth/config.js");
    await writeConfig({ token: "keep-me", email: "user@example.com", plan: "free" });

    const patched = await patchConfig({ plan: "pro" });
    expect(patched.token).toBe("keep-me");
    expect(patched.email).toBe("user@example.com");
    expect(patched.plan).toBe("pro");

    const reloaded = await readConfig();
    expect(reloaded).toEqual(patched);
  });

  it("two concurrent patchConfig calls both land (no lost update)", async () => {
    const { writeConfig, patchConfig, readConfig } = await import("../../../src/auth/config.js");
    await writeConfig({ token: "keep-me" });

    // Fired concurrently (no await between them) so their reads can race
    // before either write lands, unless patchConfig serializes internally.
    const [a, b] = await Promise.all([
      patchConfig({ lastDeepScanAt: "2026-01-01T00:00:00Z" }),
      patchConfig({ lastNudgedAt: "2026-01-02T00:00:00Z" }),
    ]);

    // Each call's own return value reflects at least its own patch.
    expect(a.lastDeepScanAt).toBe("2026-01-01T00:00:00Z");
    expect(b.lastNudgedAt).toBe("2026-01-02T00:00:00Z");

    // The real regression check: without serialization, whichever patch's
    // read-modify-write loses the race overwrites the other's write —
    // the file ends up with only one of the two fields. With the mutex,
    // both are present no matter which call's write lands last.
    const reloaded = await readConfig();
    expect(reloaded.token).toBe("keep-me");
    expect(reloaded.lastDeepScanAt).toBe("2026-01-01T00:00:00Z");
    expect(reloaded.lastNudgedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("clearConfig removes the file and configExists reflects it", async () => {
    const { writeConfig, clearConfig, configExists } = await import("../../../src/auth/config.js");
    await writeConfig({ token: "t" });
    expect(await configExists()).toBe(true);

    await clearConfig();
    expect(await configExists()).toBe(false);

    // idempotent: clearing an already-missing config never throws
    await expect(clearConfig()).resolves.toBeUndefined();
  });
});
