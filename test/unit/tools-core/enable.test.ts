import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
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
    const res = await run({ rootDir: repo, homeDir: home });
    expect(res.action).toBe("needs_confirmation");
    expect(res.status).toBe("partial");
    expect(existsSync(join(home, "activation.json"))).toBe(false);
  });

  it("activates with a confirmation: records active, installs hooks, writes a receipt", async () => {
    const { home, repo } = sandbox();
    const res = await run({ rootDir: repo, homeDir: home, confirm: "yes please" });
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

  it("with the plugin installed and enabled: hooks come from the plugin, no repo-local copy", async () => {
    const { home, repo } = sandbox();
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-en-core-plug-")));
    mkdirSync(join(homeDir, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vibedrift@vibedrift": true } }));
    writeFileSync(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "vibedrift@vibedrift": [{ scope: "user", installPath: "/x", version: "0.21.0" }] } }),
    );
    const res = await run({ rootDir: repo, confirm: "yes", homeDir });
    expect(res.action).toBe("enabled");
    expect(res.hooksInstalled).toBe(true);
    expect(res.hooksVia).toBe("plugin");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
  });

  it("a whitespace-only confirmation is not a confirmation", async () => {
    const { home, repo } = sandbox();
    expect((await run({ rootDir: repo, homeDir: home, confirm: "   " })).action).toBe("needs_confirmation");
  });

  it("decline records a no without a confirmation and never installs hooks", async () => {
    const { home, repo } = sandbox();
    const res = await run({ rootDir: repo, homeDir: home, decline: true });
    expect(res.action).toBe("declined");
    expect(res.status).toBe("ok");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(home), projectHash)).toBe("declined");
  });

  it("enable reverses a prior decline", async () => {
    const { home, repo } = sandbox();
    await run({ rootDir: repo, homeDir: home, decline: true });
    await run({ rootDir: repo, homeDir: home, confirm: "ok" });
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(home), projectHash)).toBe("active");
  });

  it("refuses a rootDir with no project marker, before touching anything", async () => {
    // enable installs agent hook config into rootDir, and rootDir is fully
    // caller-controlled over MCP. The Allow/Deny prompt plus `confirm` are the
    // primary consent gate; assertPlausibleProjectRoot is the defense-in-depth
    // that stops a marker-less target outright. The guard has its own unit
    // tests, but nothing bound it to THIS call site: deleting the call left all
    // 17 tests here green.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "vd-bare-")));
    process.env.VIBEDRIFT_HOME = realpathSync(mkdtempSync(join(tmpdir(), "vd-home-")));
    await expect(run({ rootDir: bare, confirm: "yes please" })).rejects.toThrow(/doesn't look like a project directory/);
    // and nothing was recorded for it
    expect(existsSync(join(bare, ".claude"))).toBe(false);
  });
});
