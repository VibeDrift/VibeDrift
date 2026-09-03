import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin ships the session hooks to every repo where it is enabled, so
// the hook entry itself has to enforce two things the repo-local installer
// used to guarantee by construction: (1) a repo the user never activated is
// NOT captured (only the SessionStart nudge may speak), and (2) a repo that
// also carries the repo-local install is not captured twice (the repo-local
// hook owns it). Both keyed on the `--source=plugin` argument the plugin's
// wrapper passes; a repo-local install never passes it.
const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const CLI = join(process.cwd(), "src", "cli", "index.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
function env(home: string) {
  return { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "" };
}
function run(home: string, payload: unknown, args: string[] = [], entry = ENTRY) {
  return spawnSync(TSX, [entry, ...args], { input: JSON.stringify(payload), encoding: "utf8", env: env(home), timeout: 30_000 });
}
function repoDir(): string {
  const repo = tmp("vd-plugin-repo-");
  mkdirSync(join(repo, ".git"));
  return repo;
}
function ledgerExists(home: string): boolean {
  const sessions = join(home, ".vibedrift", "sessions");
  if (!existsSync(sessions)) return false;
  return readdirSync(sessions).some((h) => readdirSync(join(sessions, h)).some((f) => f.endsWith(".jsonl")));
}
function activate(home: string, repo: string): void {
  // `vibedrift enable --yes`-equivalent: the CLI's activation store, written
  // the same way the enable command does. Runs the real CLI so the record is
  // exactly what production writes.
  const r = spawnSync(TSX, [CLI, "enable", repo], { input: "y\n", encoding: "utf8", env: env(home), timeout: 60_000 });
  expect(r.status).toBe(0);
}

const edit = (repo: string, sid: string) => ({
  session_id: sid,
  cwd: repo,
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: join(repo, "src", "a.ts"), content: "export const a = 1;\n" },
});

describe("plugin-mode hook gates (--source=plugin)", () => {
  it("an un-activated repo is NOT captured: exit 0, no ledger, and the SessionStart nudge still speaks", () => {
    const home = tmp("vd-plugin-home-");
    const repo = repoDir();
    const start = run(home, { session_id: "p1", cwd: repo, hook_event_name: "SessionStart", source: "startup" }, ["--source=plugin"]);
    expect(start.status).toBe(0);
    expect(start.stdout).toContain("NOT active"); // the nudge, unchanged
    const e = run(home, edit(repo, "p1"), ["--source=plugin"]);
    expect(e.status).toBe(0);
    expect(e.stderr).toBe("");
    expect(ledgerExists(home)).toBe(false);
  });

  it("the same un-activated repo IS captured without --source=plugin (repo-local grandfather unchanged)", () => {
    const home = tmp("vd-plugin-home-");
    const repo = repoDir();
    const e = run(home, edit(repo, "l1"));
    expect(e.status).toBe(0);
    expect(ledgerExists(home)).toBe(true);
  });

  it("an activated repo is captured in plugin mode exactly as in repo-local mode", () => {
    const home = tmp("vd-plugin-home-");
    const repo = repoDir();
    activate(home, repo);
    const e = run(home, edit(repo, "p2"), ["--source=plugin"]);
    expect(e.status).toBe(0);
    expect(ledgerExists(home)).toBe(true);
  });

  it("yields to a repo-local install: with #vibedrift-hook in settings.local.json the plugin run writes nothing", () => {
    const home = tmp("vd-plugin-home-");
    const repo = repoDir();
    activate(home, repo);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/hook-entry.js #vibedrift-hook" }] }] } }),
    );
    const e = run(home, edit(repo, "p3"), ["--source=plugin"]);
    expect(e.status).toBe(0);
    expect(ledgerExists(home)).toBe(false);
    // the repo-local hook (no --source) still captures
    const local = run(home, edit(repo, "p3"));
    expect(local.status).toBe(0);
    expect(ledgerExists(home)).toBe(true);
    void readFileSync;
  });

  it("the CLI's hidden session-hook subcommand runs the same entry", () => {
    const home = tmp("vd-plugin-home-");
    const repo = repoDir();
    activate(home, repo);
    const r = spawnSync(TSX, [CLI, "session-hook", "--source=plugin"], {
      input: JSON.stringify(edit(repo, "p4")),
      encoding: "utf8",
      env: env(home),
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(ledgerExists(home)).toBe(true);
  });
});
