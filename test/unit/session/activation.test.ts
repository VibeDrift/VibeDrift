import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  ASK_BUDGET,
  activationPath,
  loadActivation,
  recordAnswer,
  projectStatus,
  isUnderGrant,
  consumeAsk,
  resolveGrantPath,
  addDirGrant,
  DirGrantRefusedError,
} from "@/session/activation";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-act-")));

describe("activation store", () => {
  it("missing file loads as empty (unanswered)", () => {
    const home = tmp();
    const store = loadActivation(home);
    expect(store).toEqual({ v: 1, projects: {}, dirGrants: [] });
    expect(projectStatus(store, "h1")).toBe("unanswered");
  });

  it("corrupt or wrong-version files fail open to empty", () => {
    const home = tmp();
    writeFileSync(activationPath(home), "{nope");
    expect(loadActivation(home).projects).toEqual({});
    writeFileSync(activationPath(home), JSON.stringify({ v: 99, projects: { h: { state: "active" } } }));
    expect(loadActivation(home).projects).toEqual({});
  });

  it("recordAnswer round-trips and wins over everything", () => {
    const home = tmp();
    recordAnswer("h1", "active", "cli-enable", home);
    const store = loadActivation(home);
    expect(projectStatus(store, "h1")).toBe("active");
    expect(store.projects.h1.surface).toBe("cli-enable");
    expect(store.projects.h1.at).toBeTruthy();
    // reversal: decline then re-enable
    recordAnswer("h1", "declined", "cli-decline", home);
    expect(projectStatus(loadActivation(home), "h1")).toBe("declined");
    recordAnswer("h1", "active", "cli-enable", home);
    expect(projectStatus(loadActivation(home), "h1")).toBe("active");
  });

  it("a covering dir grant activates an unanswered repo; explicit decline still wins", () => {
    const home = tmp();
    const work = tmp();
    addDirGrant(work, home);
    let store = loadActivation(home);
    expect(projectStatus(store, "h1", join(work, "repo-a"))).toBe("active");
    expect(projectStatus(store, "h1", work)).toBe("active"); // the granted dir itself
    recordAnswer("h1", "declined", "cli-decline", home);
    store = loadActivation(home);
    expect(projectStatus(store, "h1", join(work, "repo-a"))).toBe("declined");
  });

  it("grant matching is path-segment safe (sibling /work2 not under /work)", () => {
    const home = tmp();
    const base = tmp();
    const work = join(base, "work");
    mkdirSync(work);
    mkdirSync(join(base, "work2"));
    addDirGrant(work, home);
    const store = loadActivation(home);
    expect(isUnderGrant(store, join(base, "work2"))).toBe(false);
    expect(isUnderGrant(store, join(base, "work", "deep", "repo"))).toBe(true);
  });

  it("addDirGrant dedupes identical paths", () => {
    const home = tmp();
    const work = tmp();
    addDirGrant(work, home);
    addDirGrant(work, home);
    expect(loadActivation(home).dirGrants).toHaveLength(1);
  });

  it("writes are atomic-ish: file is valid JSON with restrictive perms", () => {
    const home = tmp();
    recordAnswer("h1", "active", "cli-enable", home);
    const raw = readFileSync(activationPath(home), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("ask budget (L-N8)", () => {
  it("allows ASK_BUDGET asks, then goes quiet WITHOUT declining (grandfather safe)", () => {
    const home = tmp();
    for (let i = 1; i <= ASK_BUDGET; i++) {
      const out = consumeAsk("h1", home);
      expect(out.ask).toBe(true);
      expect(out.askCount).toBe(i);
      expect(out.budgetExpired).toBe(i === ASK_BUDGET);
    }
    const store = loadActivation(home);
    // expiry marks the breadcrumb but must NOT write `declined` — a
    // grandfathered capturing repo stays capturing (projectStatus == unanswered).
    expect(store.projects.h1.breadcrumbShown).toBe(true);
    expect(store.projects.h1.state).toBeUndefined();
    expect(projectStatus(store, "h1")).toBe("unanswered");
    // no fourth ask, and askCount does not creep past the budget
    const fourth = consumeAsk("h1", home);
    expect(fourth.ask).toBe(false);
    expect(loadActivation(home).projects.h1.askCount).toBe(ASK_BUDGET);
  });

  it("never asks once an explicit answer exists", () => {
    const home = tmp();
    recordAnswer("h1", "active", "cli-enable", home);
    expect(consumeAsk("h1", home)).toEqual({ ask: false, askCount: 0, budgetExpired: false });
    recordAnswer("h2", "declined", "cli-decline", home);
    expect(consumeAsk("h2", home).ask).toBe(false);
  });

  it("budgets are per-project", () => {
    const home = tmp();
    consumeAsk("h1", home);
    consumeAsk("h1", home);
    const other = consumeAsk("h2", home);
    expect(other.askCount).toBe(1);
  });
});

describe("dir-grant refusals (O19)", () => {
  it("refuses $HOME outright", () => {
    expect(() => resolveGrantPath(homedir())).toThrow(DirGrantRefusedError);
  });

  it("refuses an ANCESTOR of $HOME (broader than $HOME — e.g. /Users)", () => {
    // dirname(home) is a real, existing ancestor of home on every platform.
    const parent = join(homedir(), "..");
    expect(() => resolveGrantPath(parent)).toThrow(DirGrantRefusedError);
  });

  it("allows a SUBDIRECTORY of $HOME (the intended grant, e.g. ~/work)", () => {
    const work = realpathSync(mkdtempSync(join(homedir(), ".vd-grant-ok-")));
    try {
      expect(resolveGrantPath(work)).toBe(work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("refuses the filesystem root", () => {
    const root = parse(process.cwd()).root;
    expect(() => resolveGrantPath(root)).toThrow(DirGrantRefusedError);
  });

  it("throws on nonexistent paths", () => {
    expect(() => resolveGrantPath(join(tmpdir(), "vd-definitely-missing-xyz"))).toThrow();
  });

  it("canonicalizes symlinks to the real path", () => {
    const base = tmp();
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(resolveGrantPath(link)).toBe(real);
  });
});
