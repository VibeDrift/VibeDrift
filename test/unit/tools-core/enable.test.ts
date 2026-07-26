import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@/tools-core/tools/enable";
import { loadActivation, projectStatus } from "@/session/activation";
import { repoIdentity } from "@/session/repo";

const prev = process.env.VIBEDRIFT_HOME;
afterEach(() => {
  if (prev === undefined) delete process.env.VIBEDRIFT_HOME;
  else process.env.VIBEDRIFT_HOME = prev;
});

function sandbox(): { home: string; repo: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vd-en-core-home-")));
  process.env.VIBEDRIFT_HOME = home;
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-en-core-repo-")));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".claude")); // supported agent present
  return { home, repo };
}

describe("enable tool core (O18)", () => {
  it("refuses to activate without a confirmation and records nothing", async () => {
    const { home, repo } = sandbox();
    const res = await run({ rootDir: repo });
    expect(res.action).toBe("needs_confirmation");
    expect(res.status).toBe("partial");
    expect(existsSync(join(home, "activation.json"))).toBe(false);
  });

  it("activates with a confirmation: records active, installs hooks, writes a receipt", async () => {
    const { home, repo } = sandbox();
    const res = await run({ rootDir: repo, confirm: "yes please" });
    expect(res.action).toBe("enabled");
    expect(res.status).toBe("ok");
    expect(res.hooksInstalled).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);

    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(home), projectHash)).toBe("active");
    const receipt = JSON.parse(
      readFileSync(join(home, "sessions", projectHash, "consent.log"), "utf8").trim(),
    );
    expect(receipt.action).toBe("enable");
    expect(receipt.surface).toBe("mcp-enable");
  });

  it("a whitespace-only confirmation is not a confirmation", async () => {
    const { repo } = sandbox();
    expect((await run({ rootDir: repo, confirm: "   " })).action).toBe("needs_confirmation");
  });

  it("decline records a no without a confirmation and never installs hooks", async () => {
    const { home, repo } = sandbox();
    const res = await run({ rootDir: repo, decline: true });
    expect(res.action).toBe("declined");
    expect(res.status).toBe("ok");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(home), projectHash)).toBe("declined");
  });

  it("enable reverses a prior decline", async () => {
    const { home, repo } = sandbox();
    await run({ rootDir: repo, decline: true });
    await run({ rootDir: repo, confirm: "ok" });
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(home), projectHash)).toBe("active");
  });
});
