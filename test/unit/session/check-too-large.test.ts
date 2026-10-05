import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, writeBaseline, baselineCachePath, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";

/**
 * Issue #118, byte-cap half: a repo whose persisted baseline is too large for
 * the hook to read inside its budget must say so — reason "too_large" plus a
 * once-per-session notice — never the misleading "no_baseline" ("no patterns
 * yet") it gets today because loadBaselineUnchecked collapses "missing" and
 * "too big" into the same null.
 *
 * The default loader is exercised on purpose (no loadBaselineFor injection):
 * the bug lives in what the default does with an oversized cache file.
 */

const EDIT_BODY = `export async function loadReport(id: string) {
  return await fetch("/api/report/" + id);
}`;

let repo: string;
let repoNoBaseline: string;
let sessionsDir: string;

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-toolarge-repo-")));
  repoNoBaseline = realpathSync(mkdtempSync(join(tmpdir(), "vd-nobaseline-repo-")));
  sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-toolarge-sessions-")));
  for (const r of [repo, repoNoBaseline]) {
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
  }
  const baseline: RepoDriftBaseline = await buildBaseline(repo);
  await writeBaseline(baseline);
  // Push the persisted cache past the real 8 MiB hook cap while keeping it
  // valid JSON (trailing whitespace parses): on current code this reads back
  // as "no_baseline", which is the mislabel under test.
  appendFileSync(baselineCachePath(repo), " ".repeat(9 * 1024 * 1024));
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(repoNoBaseline, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
  // the baseline cache is global, keyed by the repo's project hash
  rmSync(baselineCachePath(repo), { force: true });
});

const opts = (rootDir: string, over: Record<string, unknown> = {}) => ({
  rootDir,
  projectHash: "feedfacefeedface",
  sessionId: "s-toolarge",
  sessionsDir,
  file: join(rootDir, "src", "routes.ts"),
  body: EDIT_BODY,
  ...over,
});

describe("runEditChecks — oversized persisted baseline (#118)", () => {
  it("stamps too_large with a once-per-session notice, never no_baseline", async () => {
    const first = await runEditChecks(opts(repo));
    expect(first.checked).toBe(false);
    expect(first.reason).toBe("too_large");
    expect(first.notice).toContain("checks are paused");
    expect(first.notice).toContain("marked as not checked");

    const second = await runEditChecks(opts(repo));
    expect(second.checked).toBe(false);
    expect(second.reason).toBe("too_large");
    expect(second.notice).toBeNull();
  });

  it("keeps a genuinely missing baseline distinct: no_baseline, no notice", async () => {
    const out = await runEditChecks(opts(repoNoBaseline, { baselineMaxBytes: 1, sessionId: "s-missing" }));
    expect(out.checked).toBe(false);
    expect(out.reason).toBe("no_baseline");
    expect(out.notice).toBeNull();
  });

  it("loads and checks normally when the baseline fits the cap", async () => {
    const out = await runEditChecks(opts(repo, { baselineMaxBytes: 16 * 1024 * 1024, sessionId: "s-fits" }));
    expect(out.checked).toBe(true);
    expect(out.reason).toBeUndefined();
  });
});
