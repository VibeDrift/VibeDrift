import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hook install is paid-gated; default the cached plan to a paid plan so the
// install/uninstall tests exercise the real file logic. The free-gate test
// overrides it.
vi.mock("../../../src/auth/config.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/auth/config.js")>();
  return { ...actual, readConfig: vi.fn(async () => ({ plan: "pro" })) };
});

import { buildHookScript, runHook, resolveHooksDir, HOOK_MARKER } from "../../../src/cli/commands/hook.js";
import { readConfig } from "../../../src/auth/config.js";

describe("buildHookScript", () => {
  it("includes the marker, threshold, and the fail-on-score invocation", () => {
    const s = buildHookScript(65);
    expect(s.startsWith("#!/bin/sh")).toBe(true);
    expect(s).toContain(HOOK_MARKER);
    expect(s).toContain("--fail-on-score 65");
    expect(s).toContain("git push --no-verify");
  });
});

describe("runHook in a temp git repo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vd-hook-"));
    execFileSync("git", ["init", "-q", dir]);
    (readConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: "pro" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("install writes an executable pre-push hook with the marker", async () => {
    await runHook("install", { threshold: 80 }, dir);
    const hookPath = join(await resolveHooksDir(dir), "pre-push");
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, "utf8");
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain("--fail-on-score 80");
    // Unix file permissions don't exist on Windows — skip this check there
    if (process.platform !== "win32") {
      expect(statSync(hookPath).mode & 0o100).toBeTruthy(); // owner-executable
    }
  });

  it("uninstall removes a VibeDrift-created hook", async () => {
    await runHook("install", {}, dir);
    const hookPath = join(await resolveHooksDir(dir), "pre-push");
    expect(existsSync(hookPath)).toBe(true);
    await runHook("uninstall", {}, dir);
    expect(existsSync(hookPath)).toBe(false);
  });

  it("install is paid-only — a free plan is blocked and writes no hook", async () => {
    (readConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: "free" });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => {
        throw new Error("process.exit");
      }) as never);
    await expect(runHook("install", { threshold: 80 }, dir)).rejects.toThrow("process.exit");
    const hookPath = join(await resolveHooksDir(dir), "pre-push");
    expect(existsSync(hookPath)).toBe(false); // gated before any write
    exitSpy.mockRestore();
  });

  it("install refuses to clobber a foreign pre-push hook without --force", async () => {
    const hookPath = join(await resolveHooksDir(dir), "pre-push");
    writeFileSync(hookPath, "#!/bin/sh\necho not ours\n");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => {
        throw new Error("process.exit");
      }) as never);
    await expect(runHook("install", {}, dir)).rejects.toThrow("process.exit");
    expect(readFileSync(hookPath, "utf8")).toContain("not ours"); // preserved
    exitSpy.mockRestore();
  });
});
