import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";

/**
 * In-loop precision eval.
 *
 * Every case below is a real finding from a recorded drift session, with its
 * verdict established by reading the actual source. The synthetic repo
 * reproduces the structure that produced them: a directory that is unanimous on
 * one convention, a directory that is mixed and therefore carries the only
 * detector vote, a directory below the dominance threshold, plus the test,
 * script and seed classes an agent legitimately writes differently.
 *
 * The gate is precision, not count. A change that raises recall while dropping
 * precision below the floor does not ship. That is the mechanism that would
 * have caught all four of the audited defects before a user saw them.
 */

const PRECISION_FLOOR = 0.9;

let repo: string;
let sessionsDir: string;
let baseline: RepoDriftBaseline;

// src/components is MIXED — 5 of 6 on sentinels, which clears the detector's
// own 0.7 dominance bar. It is the only directory that produces a return-shape
// finding, so before the per-directory fix its vote became the whole repo's
// rule. Bodies are deliberately varied so no two are semantic duplicates.
const COMPONENT_SENTINEL = (n: string, i: number) => `export function ${n}(id: string) {
  const row = lookup${i}(id);
  const meta = decorate${i}(row, ${i});
  if (!row) return null;
  if (meta.hidden) return undefined;
  return { ...row, rank: ${i}, meta };
}`;
const COMPONENT_THROWS = (n: string, i: number) => `export function ${n}(id: string) {
  const row = lookup${i}(id);
  const meta = decorate${i}(row, ${i});
  if (!row) throw new Error("missing ${n}");
  if (meta.hidden) throw new Error("hidden ${n}");
  return { ...row, rank: ${i}, meta };
}`;

// src/actions is UNANIMOUS on error-object returns, so it emits no finding of
// its own — a single-pattern directory has nothing to deviate from — and
// therefore had no vote to defend itself with. That is exactly the shape that
// let a React component's convention be applied to Next.js server actions.
// Real server actions differ substantially from one another; only their RETURN
// SHAPE is shared. Each body below is structurally distinct so the duplicate
// detector has nothing to say and the eval isolates the return-shape axis.
const ACTIONS: Record<string, string> = {
  blockUser: `export async function blockUser(targetId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  if (targetId === session.user.id) return { error: COPY.cantBlockSelf };
  await db.transaction(async (tx) => {
    await tx.delete(schema.follows).where(eq(schema.follows.followerId, targetId));
    await tx.insert(schema.blocks).values({ blockerId: session.user.id, blockedId: targetId });
  });
  revalidatePath("/u/[handle]");
  return { ok: true };
}`,
  reportPost: `export async function reportPost(postId: string, reason: string, note?: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  if (!REPORT_REASONS.includes(reason)) return { error: COPY.reasonMissing };
  const trimmed = note?.trim() ?? null;
  if (trimmed && trimmed.length > 300) return { error: COPY.noteTooLong };
  const rows = await db.execute(sql\`select 1 from posts where id = \${postId}\`);
  if (rows.length === 0) return { error: COPY.notVisible };
  return { ok: true };
}`,
  requestAccountDeletion: `export async function requestAccountDeletion() {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  const userId = session.user.id;
  const rl = await rateLimit("account:delete", userId);
  if (!rl.ok) return { error: COPY.rateLimited };
  try {
    const pending = await db.query.deletions.findFirst({ where: eq(schema.deletions.userId, userId) });
    if (pending) return { error: COPY.deletionAlreadyRequested };
    await db.insert(schema.deletions).values({ userId, requestedAt: new Date(), stage: "pending" });
    await notifyOps("account-deletion", { userId });
  } catch (e) {
    await logError("requestAccountDeletion", e);
    return { error: mapDbError(e) };
  }
  return { ok: true };
}`,
  one: `export async function updateHandle(handle: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) return { error: COPY.badHandle };
  const taken = await db.query.users.findFirst({ where: eq(schema.users.handle, handle) });
  if (taken) return { error: COPY.handleTaken };
  await db.update(schema.users).set({ handle });
  return { ok: true };
}`,
  two: `export async function setTimezone(tz: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  if (!SUPPORTED_ZONES.has(tz)) return { error: COPY.badTimezone };
  await db.update(schema.users).set({ timezone: tz });
  revalidatePath("/today");
  return { ok: true };
}`,
  three: `export async function resolveReport(reportId: string, resolution: string) {
  const admin = await requireAdmin();
  const report = await db.query.reports.findFirst({ where: eq(schema.reports.id, reportId) });
  if (!report) return { error: COPY.somethingWrong };
  await db.update(schema.reports).set({ resolvedAt: new Date(), resolvedBy: admin.userId, resolution });
  return { ok: true };
}`,
  four: `export async function shareDay(date: string, handle: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: COPY.signedOut };
  const invitee = await db.query.users.findFirst({ where: eq(schema.users.handle, handle) });
  if (!invitee) return { error: COPY.unknownHandle };
  if (invitee.id === session.user.id) return { error: COPY.cantShareSelf };
  await db.insert(schema.sharedDays).values({ date, ownerId: session.user.id, inviteeId: invitee.id });
  return { ok: true };
}`,
};

const cases: Array<{
  id: string;
  file: string;
  body: string;
  expected: "flag" | "silence";
  why: string;
}> = [
  {
    id: "DF-3 server action",
    file: "src/actions/blocks.ts",
    body: ACTIONS.blockUser,
    expected: "silence",
    why: "src/actions is 10/10 on error-object returns; it was judged against src/components",
  },
  {
    id: "DF-9 server action",
    file: "src/actions/reports.ts",
    body: ACTIONS.reportPost,
    expected: "silence",
    why: "same unanimous server-action convention",
  },
  {
    id: "DF-16 server action",
    file: "src/actions/account.ts",
    body: ACTIONS.requestAccountDeletion,
    expected: "silence",
    why: "same unanimous server-action convention",
  },
  {
    id: "DF-15 test file",
    file: "src/lib/rate-limit.test.ts",
    body: `export function freshLimiter() {
  const client = makeClient();
  if (!client) throw new Error("no client");
  throw new Error("always fails, on purpose");
}`,
    expected: "silence",
    why: "a test file classified from deliberate fault injection inside mocks",
  },
  {
    id: "DF-18 seed script",
    file: "scripts/seed-dev.ts",
    body: `export async function assertDevDatabase(url: string) {
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!url.includes("_dev")) throw new Error("refusing to seed a non-dev database");
  return true;
}`,
    expected: "silence",
    why: "throwing is the guard that stops the script truncating a real database",
  },
  {
    id: "faabedb8 DF-1 test global-setup",
    file: "tests/integration/global-setup.ts",
    body: `export async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("global-setup: DATABASE_URL is not set");
  if (!url.includes("_test")) throw new Error("global-setup: refusing to truncate");
  return true;
}`,
    expected: "silence",
    why: "a globalSetup has no caller to inspect a sentinel; the file says so in its own doc comment",
  },
  {
    id: "component deviating from its OWN directory",
    file: "src/components/NewThing.tsx",
    body: COMPONENT_THROWS("NewThing", 14),
    expected: "flag",
    why: "src/components really is 5/6 on sentinels, so a throwing component deviates from its peers",
  },
];

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-eval-repo-")));
  sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-eval-sessions-")));
  for (const d of ["src/components", "src/actions", "src/lib", "scripts", "tests/integration"]) {
    mkdirSync(join(repo, d), { recursive: true });
  }
  // MIXED: 5 sentinels, 1 throws = 0.83, clearing the 0.7 dominance bar, so
  // this is the only directory that emits a return-shape finding.
  ["a", "b", "c", "d", "e"].forEach((n, i) => {
    writeFileSync(join(repo, `src/components/${n.toUpperCase()}.tsx`), `${COMPONENT_SENTINEL(n, i)}\n`);
  });
  writeFileSync(join(repo, "src/components/F.tsx"), `${COMPONENT_THROWS("f", 5)}\n`);
  // UNANIMOUS on error-object returns -> emits no finding, so has no vote.
  for (const n of ["one", "two", "three", "four"]) {
    writeFileSync(join(repo, `src/actions/${n}.ts`), `${ACTIONS[n]}\n`);
  }
  baseline = await buildBaseline(repo);
}, 120_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

async function runCase(c: (typeof cases)[number]) {
  const out = await runEditChecks({
    rootDir: repo,
    projectHash: "eva1eva1eva1eva1",
    sessionId: `eval-${c.id.replace(/[^a-z0-9]/gi, "-")}`,
    sessionsDir,
    file: join(repo, c.file),
    body: c.body,
    loadBaselineFor: async () => baseline,
  });
  if (process.env.EVAL_DEBUG === "1" && out.flags.length) {
    console.log(`  [${c.id}] flagged:`, out.flags.map((f) => `${f.detail.category}:${JSON.stringify(f.detail).slice(0, 140)}`));
  }
  return out.flags.length > 0;
}

describe("in-loop precision eval", () => {
  it("the fixture repo produces a return-shape vote only for src/components", () => {
    const dirs = Object.keys(baseline.perDirectoryVote?.return_shape_consistency ?? {});
    expect(dirs).toEqual(["src/components"]);
  });

  for (const c of cases) {
    it(`${c.expected === "flag" ? "flags" : "stays silent on"}: ${c.id}`, async () => {
      expect(await runCase(c), c.why).toBe(c.expected === "flag");
    }, 30_000);
  }

  it("does not regress below the precision floor", async () => {
    let flagged = 0;
    let correct = 0;
    for (const c of cases) {
      if (!(await runCase(c))) continue;
      flagged++;
      if (c.expected === "flag") correct++;
    }
    const precision = flagged === 0 ? 1 : correct / flagged;
    expect(precision, `precision ${precision.toFixed(2)} across ${cases.length} audited cases`).toBeGreaterThanOrEqual(
      PRECISION_FLOOR,
    );
  }, 120_000);

  it("still catches the known true positive", async () => {
    const tp = cases.find((c) => c.expected === "flag")!;
    expect(await runCase(tp)).toBe(true);
  }, 30_000);
});
