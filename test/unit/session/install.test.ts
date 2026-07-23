import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks, uninstallHooks, hooksStatus, HOOK_MARKER } from "@/session/install";

const HOOK_CMD = "/usr/local/bin/node /x/dist/session/hook-entry.js";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeOpts(sessionsDir: string) {
  return { hookCommand: HOOK_CMD, sessionsDir, projectHash: "cafebabecafebabe" };
}

const settingsPath = (repo: string) => join(repo, ".claude", "settings.local.json");

describe("installHooks", () => {
  it("creates settings.local.json with marker-tagged hooks for all four events", async () => {
    const repo = tmp("vd-inst-");
    const res = await installHooks(repo, makeOpts(tmp("vd-sess-")));
    expect(res.status).toBe("installed");
    const parsed = JSON.parse(readFileSync(settingsPath(repo), "utf8"));
    for (const eventName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
      const groups = parsed.hooks[eventName];
      expect(Array.isArray(groups)).toBe(true);
      const cmds = groups.flatMap((g: { hooks: Array<{ command: string }> }) =>
        g.hooks.map((h) => h.command),
      );
      expect(cmds.some((c: string) => c.includes(HOOK_MARKER))).toBe(true);
    }
    const postGroups = parsed.hooks.PostToolUse;
    expect(postGroups[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(postGroups[0].hooks[0].timeout).toBe(10);
  });

  it("is idempotent: second install returns already and leaves bytes unchanged", async () => {
    const repo = tmp("vd-idem-");
    const opts = makeOpts(tmp("vd-sess-"));
    await installHooks(repo, opts);
    const before = readFileSync(settingsPath(repo), "utf8");
    const res = await installHooks(repo, opts);
    expect(res.status).toBe("already");
    expect(readFileSync(settingsPath(repo), "utf8")).toBe(before);
  });

  it("refuses to clobber unparseable settings", async () => {
    const repo = tmp("vd-clob-");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(settingsPath(repo), "{ this is not json");
    const res = await installHooks(repo, makeOpts(tmp("vd-sess-")));
    expect(res.status).toBe("aborted_unparseable");
    expect(readFileSync(settingsPath(repo), "utf8")).toBe("{ this is not json");
  });

  it("preserves a user's existing hooks", async () => {
    const repo = tmp("vd-keep-");
    mkdirSync(join(repo, ".claude"));
    const original = `{
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo mine" } ] } ]
  }
}`;
    writeFileSync(settingsPath(repo), original);
    await installHooks(repo, makeOpts(tmp("vd-sess-")));
    const parsed = JSON.parse(readFileSync(settingsPath(repo), "utf8"));
    const cmds = parsed.hooks.PostToolUse.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("echo mine");
    expect(cmds.some((c: string) => c.includes(HOOK_MARKER))).toBe(true);
    expect(parsed.permissions.allow).toEqual(["Bash(ls:*)"]);
  });
});

describe("uninstallHooks", () => {
  it("deletes the file entirely when we created it and it holds only our entries", async () => {
    const repo = tmp("vd-del-");
    const opts = makeOpts(tmp("vd-sess-"));
    await installHooks(repo, opts);
    const res = await uninstallHooks(repo, opts);
    expect(res.status).toBe("removed");
    expect(existsSync(settingsPath(repo))).toBe(false);
  });

  it("restores the original bytes exactly, odd formatting included", async () => {
    const repo = tmp("vd-bytes-");
    mkdirSync(join(repo, ".claude"));
    const original = `{\n    "permissions":   { "allow": [] }\n}\n`;
    writeFileSync(settingsPath(repo), original);
    const opts = makeOpts(tmp("vd-sess-"));
    await installHooks(repo, opts);
    expect(readFileSync(settingsPath(repo), "utf8")).not.toBe(original);
    const res = await uninstallHooks(repo, opts);
    expect(res.status).toBe("restored");
    expect(readFileSync(settingsPath(repo), "utf8")).toBe(original);
  });

  it("falls back to surgical removal when the user edited settings after install", async () => {
    const repo = tmp("vd-surg-");
    const opts = makeOpts(tmp("vd-sess-"));
    await installHooks(repo, opts);
    const parsed = JSON.parse(readFileSync(settingsPath(repo), "utf8"));
    parsed.hooks.PostToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo added-later" }],
    });
    writeFileSync(settingsPath(repo), JSON.stringify(parsed, null, 2));
    const res = await uninstallHooks(repo, opts);
    expect(res.status).toBe("removed_surgical");
    const after = JSON.parse(readFileSync(settingsPath(repo), "utf8"));
    const all = JSON.stringify(after);
    expect(all).toContain("echo added-later");
    expect(all).not.toContain(HOOK_MARKER);
  });

  it("reports not_installed when nothing of ours is present", async () => {
    const repo = tmp("vd-none-");
    const res = await uninstallHooks(repo, makeOpts(tmp("vd-sess-")));
    expect(res.status).toBe("not_installed");
  });
});

describe("hooksStatus", () => {
  it("reflects installed state", async () => {
    const repo = tmp("vd-stat-");
    const opts = makeOpts(tmp("vd-sess-"));
    expect((await hooksStatus(repo)).installed).toBe(false);
    await installHooks(repo, opts);
    expect((await hooksStatus(repo)).installed).toBe(true);
    await uninstallHooks(repo, opts);
    expect((await hooksStatus(repo)).installed).toBe(false);
  });
});
