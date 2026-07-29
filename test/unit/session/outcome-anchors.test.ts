/**
 * Fidelity fixtures for finding-scoped resolution: every case here raises a
 * REAL finding through runEditChecks (the flag path an agent edit takes) and
 * then re-checks the file's full post-edit content, exactly as the hook does.
 *
 * Each fixture is a way the re-check used to lose sight of the flagged code
 * while that code was still byte-identical on disk.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";
import { readOutcomeState, recheckFile, writeOutcomeState, type OpenFinding } from "@/session/outcomes";
import { fileConstructs, ANCHOR_MAX_TOKENS } from "@/session/finding-anchor";
import { classifyDataAccessLabel } from "@/drift/architectural-contradiction";
import type { SessionEvent } from "@/session/types";

const HELPER_BODY = `export function exponentialBackoff(attempt: number): number {
  const base = 250;
  const cap = 30_000;
  const jitter = Math.random() * 100;
  return Math.min(cap, base * 2 ** attempt) + jitter;
}`;

let repo: string;
let sessionsDir: string;
let baseline: RepoDriftBaseline;

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-anchor-repo-")));
  sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-anchor-sessions-")));
  mkdirSync(join(repo, "src", "data"), { recursive: true });
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  // Declared rules make both dominants binding regardless of vote thresholds.
  writeFileSync(
    join(repo, "CLAUDE.md"),
    "# Conventions\n- Async: use async/await throughout. No .then() chains.\n- Data access: go through Prisma ORM methods only.\n",
  );
  for (const n of ["users", "orders", "teams", "seats"]) {
    writeFileSync(
      join(repo, "src", "data", `${n}.ts`),
      `export async function list_${n}(team: string) {\n  const rows = await prisma.${n}.findMany({ where: { team } });\n  const extra = await prisma.${n}.findOne({ where: { team } });\n  return [...rows, extra];\n}\n`,
    );
  }
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER_BODY}\n`);
  baseline = await buildBaseline(repo);
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** Raise findings the way the hook does, and hand back the open findings the
 *  hook would have recorded (one per flag). */
async function raise(
  sessionId: string,
  relFile: string,
  body: string,
): Promise<{ flags: SessionEvent[]; open: OpenFinding[] }> {
  const out = await runEditChecks({
    rootDir: repo,
    projectHash: "feedfacefeedface",
    sessionId,
    sessionsDir,
    file: join(repo, relFile),
    body,
    loadBaselineFor: async () => baseline,
  });
  const open = out.flags.map((f) => ({
    findingId: f.findingId!,
    file: f.detail.file!,
    category: f.detail.category!,
    anchor: out.anchors[f.findingId!],
  }));
  return { flags: out.flags, open };
}

const only = (open: OpenFinding[], category: string): OpenFinding[] => {
  const hit = open.filter((f) => f.category === category);
  expect(hit).toHaveLength(1);
  return hit;
};

describe("fidelity: the flagged code is still there", () => {
  it("a duplicate past the function-query cap does not clear", async () => {
    const { open } = await raise("s-cap", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    expect(dup[0].anchor).toMatchObject({ kind: "function", symbol: "exponentialBackoff" });

    // The clone is the 7th function in the file, past the 5-function cap the
    // multi-query decomposition uses, and the whole-file query dilutes it.
    const whole = `export function one(a: number) { return a + 1; }
export function two(a: number) { return a + 2; }
export function three(a: number) { return a + 3; }
export function four(a: number) { return a + 4; }
export function five(a: number) { return a + 5; }
export function six(a: number) { return a + 6; }
${HELPER_BODY}`;
    expect(recheckFile(baseline, "src/util.ts", whole, dup).resolved).toEqual([]);
  });

  it("raw SQL in a method outvoted by the file's ORM calls does not clear", async () => {
    const method = `  async purgeSessions(userId: string) {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await db.query("INSERT INTO audit_log (kind) VALUES ('purge')", []);
    return true;
  }`;
    const { open } = await raise("s-sql", "src/data/sessions.ts", method);
    const arch = only(open, "architectural_consistency");
    // A class method is not an extractable function, so the anchor is the whole
    // edited body and presence is asked over the whole file.
    expect(arch[0].anchor).toMatchObject({ kind: "file", observed: "raw SQL queries" });

    const whole = `export class SessionStore {
  async findSession(id: string) {
    return prisma.session.findOne({ where: { id } });
  }
  async listSessions(userId: string) {
    return prisma.session.findMany({ where: { userId } });
  }
  async countSessions(userId: string) {
    const all = await prisma.session.findAll({ where: { userId } });
    return all.length;
  }
${method}
}`;
    expect(recheckFile(baseline, "src/data/sessions.ts", whole, arch).resolved).toEqual([]);
  });

  it("a half-converted body still holding a .then() chain does not clear", async () => {
    const then = `export function loadReport(id: string) {
  return readRows(id)
    .then((rows) => rows.filter(Boolean))
    .then((rows) => rows.slice(0, 20));
}`;
    const { open } = await raise("s-half", "src/reports.ts", then);
    const async_ = only(open, "async_patterns");
    expect(async_[0].anchor).toMatchObject({
      kind: "function",
      symbol: "loadReport",
      observed: ".then() chains",
    });

    // Half converted: one await, one surviving .then() — the file now reads as
    // "mixed", which the dimension check cannot classify at all.
    const half = `export async function loadReport(id: string) {
  const rows = await readRows(id);
  return rows.filter(Boolean).then((r) => r.slice(0, 20));
}`;
    expect(recheckFile(baseline, "src/reports.ts", half, async_).resolved).toEqual([]);
  });

  it("a 4:1 whole-file majority does not clear the untouched .then() function", async () => {
    const syncRows = `export function syncRows(id: string) {
  return readRows(id)
    .then((rows) => rows.map(normalize))
    .then((rows) => rows.filter(Boolean));
}`;
    const { open } = await raise("s-ratio", "src/sync.ts", syncRows);
    const async_ = only(open, "async_patterns");

    // Eight awaits against two .then() lines: the file's majority reads
    // async/await while the flagged function is untouched.
    const whole = `export async function pullUsers(team: string) {
  const rows = await prisma.users.findMany({ where: { team } });
  return await hydrate(rows);
}
export async function pullOrders(team: string) {
  const rows = await prisma.orders.findMany({ where: { team } });
  return await hydrate(rows);
}
export async function pullTeams(team: string) {
  const rows = await prisma.teams.findMany({ where: { team } });
  return await hydrate(rows);
}
export async function pullSeats(team: string) {
  const rows = await prisma.seats.findMany({ where: { team } });
  return await hydrate(rows);
}
export function normalize(row: Row) {
  return { ...row, id: String(row.id) };
}
${syncRows}`;
    expect(recheckFile(baseline, "src/sync.ts", whole, async_).resolved).toEqual([]);
  });
});

const INVOICE_THEN = `export function loadInvoice(id: string) {
  return readRows(id)
    .then((rows) => rows.map(normalize))
    .then((rows) => rows[0]);
}`;
const REPORT_THEN = `export function loadReport(id: string) {
  return readRows(id)
    .then((rows) => rows.filter(Boolean))
    .then((rows) => rows.slice(0, 20));
}`;
const REPORT_CONVERTED = `export async function loadReport(id: string) {
  const rows = await readRows(id);
  const kept = await Promise.all(rows.filter(Boolean));
  return kept.slice(0, 20);
}`;

/** Two anchors on one file, measured independently. This is a property of
 *  recheckFile, not a session the hook can produce: the hook keeps at most one
 *  open finding per (file, category), so a second async_patterns flag on
 *  src/reports.ts is deduped away and never becomes a second open finding. What
 *  this pins is that recheckFile judges each anchor on its own construct — the
 *  guarantee the hook relies on when several files, or several categories on
 *  one file, are open at once. */
describe("recheckFile judges each anchor independently", () => {
  it("resolves the converted function and keeps the untouched one open", async () => {
    const first = await raise("s-disc", "src/reports.ts", INVOICE_THEN);
    const second = await raise("s-disc", "src/reports.ts", REPORT_THEN);
    const invoice = only(first.open, "async_patterns")[0];
    const report = only(second.open, "async_patterns")[0];
    expect(invoice.findingId).not.toBe(report.findingId);

    const whole = `${INVOICE_THEN}\n${REPORT_CONVERTED}`;
    const { resolved } = recheckFile(baseline, "src/reports.ts", whole, [invoice, report]);
    expect(resolved.map((f) => f.findingId)).toEqual([report.findingId]);
  });
});

/** The flagged clone, byte-identical, wrapped in a construct the extractor does
 *  not index. The symbol leaves the index while the code sits on disk. */
const CLONE_IN_CLASS = `export class Backoff {
  exponentialBackoff(attempt: number): number {
    const base = 250;
    const cap = 30_000;
    const jitter = Math.random() * 100;
    return Math.min(cap, base * 2 ** attempt) + jitter;
  }
}`;

const CLONE_IN_OBJECT = `export const backoff = {
  exponentialBackoff(attempt: number): number {
    const base = 250;
    const cap = 30_000;
    const jitter = Math.random() * 100;
    return Math.min(cap, base * 2 ** attempt) + jitter;
  },
};`;

describe("a redundancy finding whose clone was wrapped, not removed", () => {
  it("does not clear when the flagged clone moves verbatim into a class", async () => {
    const { open } = await raise("s-dup-class", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    expect(dup[0].anchor).toMatchObject({ kind: "function", symbol: "exponentialBackoff" });
    expect(recheckFile(baseline, "src/util.ts", CLONE_IN_CLASS, dup).resolved).toEqual([]);
  });

  it("does not clear when the flagged clone moves verbatim into an object literal", async () => {
    const { open } = await raise("s-dup-object", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    expect(recheckFile(baseline, "src/util.ts", CLONE_IN_OBJECT, dup).resolved).toEqual([]);
  });

  it("clears when the duplicated function is genuinely deleted", async () => {
    const { open } = await raise("s-dup-deleted", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    const gone = `export function formatLabel(name: string): string {
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  return upper.slice(0, 40);
}`;
    expect(recheckFile(baseline, "src/util.ts", gone, dup).resolved.map((f) => f.findingId)).toEqual(
      dup.map((f) => f.findingId),
    );
  });

  it("clears when the duplicated body is genuinely rewritten under the same name", async () => {
    const { open } = await raise("s-dup-rewritten", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    const rewritten = `export function exponentialBackoff(attempt: number): number {
  const table = [100, 250, 500, 1000, 2000];
  const idx = Math.min(attempt, table.length - 1);
  return table[idx];
}`;
    expect(recheckFile(baseline, "src/util.ts", rewritten, dup).resolved.map((f) => f.findingId)).toEqual(
      dup.map((f) => f.findingId),
    );
  });

  it("clears when the clone is rewritten inside the class it was moved into", async () => {
    const { open } = await raise("s-dup-class-fixed", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");
    const fixed = `export class Backoff {
  exponentialBackoff(attempt: number): number {
    const table = [100, 250, 500, 1000, 2000];
    const idx = Math.min(attempt, table.length - 1);
    return table[idx];
  }
}`;
    expect(recheckFile(baseline, "src/util.ts", fixed, dup).resolved.map((f) => f.findingId)).toEqual(
      dup.map((f) => f.findingId),
    );
  });

  it("survives the sidecar's JSON round-trip across two separate re-checks", async () => {
    const { open } = await raise("s-dup-roundtrip", "src/util.ts", HELPER_BODY);
    const dup = only(open, "redundancy");

    await writeOutcomeState(sessionsDir, "feedfacefeedface", "s-dup-roundtrip", {
      open: dup,
      hashes: {},
    });
    const first = await readOutcomeState(sessionsDir, "feedfacefeedface", "s-dup-roundtrip");
    expect(first.open[0].anchor?.tokens?.length).toBeGreaterThan(0);
    expect(recheckFile(baseline, "src/util.ts", CLONE_IN_CLASS, first.open).resolved).toEqual([]);

    // Written back and re-read: the token sequence must not be lost between turns.
    await writeOutcomeState(sessionsDir, "feedfacefeedface", "s-dup-roundtrip", first);
    const second = await readOutcomeState(sessionsDir, "feedfacefeedface", "s-dup-roundtrip");
    expect(second.open[0].anchor?.tokens).toEqual(first.open[0].anchor?.tokens);
    expect(recheckFile(baseline, "src/util.ts", CLONE_IN_CLASS, second.open).resolved).toEqual([]);
  });
});

describe("the anchored construct moved or went away", () => {
  it("does not clear when the function is renamed but its body is unchanged", async () => {
    const { open } = await raise("s-rename", "src/reports.ts", REPORT_THEN);
    const async_ = only(open, "async_patterns");
    const renamed = REPORT_THEN.replace("loadReport", "fetchReport");
    expect(recheckFile(baseline, "src/reports.ts", renamed, async_).resolved).toEqual([]);
  });

  it("does not clear when the flagged function moves verbatim into a class", async () => {
    const { open } = await raise("s-classmove", "src/reports.ts", REPORT_THEN);
    const async_ = only(open, "async_patterns");
    expect(async_[0].anchor).toMatchObject({ kind: "function", symbol: "loadReport" });

    // Same statements, same order, now a class method. Only top-level
    // `function`/`const` forms are indexed, so the symbol leaves the index
    // while the flagged .then() chain is still byte-identical on disk.
    const moved = `export class ReportService {
  loadReport(id: string) {
    return readRows(id)
      .then((rows) => rows.filter(Boolean))
      .then((rows) => rows.slice(0, 20));
  }
}`;
    expect(recheckFile(baseline, "src/reports.ts", moved, async_).resolved).toEqual([]);
  });

  it("clears a long function that was genuinely fixed and then moved", async () => {
    // The anchor stores at most ANCHOR_MAX_TOKENS, so for a long function it is
    // a PREFIX. Here the flagged .then() chain sits past that cap, so the prefix
    // survives the fix untouched. Treating a capped sequence as proof the
    // construct is unchanged would hold this finding open forever, which is a
    // false NON-resolve: the code really was fixed.
    const filler = Array.from(
      { length: 160 },
      (_, i) => `  const v${i} = compute(${i}, base, scale);`,
    ).join("\n");
    const long = `export function loadReport(id: string) {
${filler}
  return readRows(id)
    .then((rows) => rows.filter(Boolean))
    .then((rows) => rows.slice(0, 20));
}`;
    const { open } = await raise("s-longfix", "src/reports.ts", long);
    const async_ = only(open, "async_patterns");
    expect(async_[0].anchor?.tokens?.length).toBe(ANCHOR_MAX_TOKENS);

    // Converted to async/await AND moved into a class, so the symbol leaves the
    // index and only the (unchanged) prefix is still contained in the file.
    const fixedAndMoved = `export class ReportService {
  async loadReport(id: string) {
${filler}
    const rows = await readRows(id);
    return rows.filter(Boolean).slice(0, 20);
  }
}`;
    expect(
      recheckFile(baseline, "src/reports.ts", fixedAndMoved, async_).resolved.map((f) => f.findingId),
    ).toEqual(async_.map((f) => f.findingId));
  });

  it("clears when the flagged function is deleted outright", async () => {
    const { open } = await raise("s-delete", "src/reports.ts", REPORT_THEN);
    const async_ = only(open, "async_patterns");
    const gone = `export async function loadRows(id: string) {
  const rows = await readRows(id);
  return await hydrate(rows);
}`;
    expect(recheckFile(baseline, "src/reports.ts", gone, async_).resolved.map((f) => f.findingId)).toEqual(
      async_.map((f) => f.findingId),
    );
  });

  it("clears a whole-body anchor once the flagged pattern is genuinely gone", async () => {
    const method = `  async purgeSessions(userId: string) {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await db.query("INSERT INTO audit_log (kind) VALUES ('purge')", []);
    return true;
  }`;
    const { open } = await raise("s-sql-fixed", "src/data/sessions.ts", method);
    const arch = only(open, "architectural_consistency");
    const fixed = `export class SessionStore {
  async purgeSessions(userId: string) {
    await prisma.session.delete({ where: { userId } });
    await prisma.auditLog.create({ data: { kind: "purge", userId } });
    return true;
  }
}`;
    expect(recheckFile(baseline, "src/data/sessions.ts", fixed, arch).resolved.map((f) => f.findingId)).toEqual(
      arch.map((f) => f.findingId),
    );
  });

  it("resolves nothing for a file the extractor cannot read as source", async () => {
    const { open } = await raise("s-unparsed", "src/reports.ts", REPORT_THEN);
    const moved = only(open, "async_patterns").map((f) => ({ ...f, file: "notes/scratch.txt" }));
    expect(recheckFile(baseline, "notes/scratch.txt", "", moved).resolved).toEqual([]);
  });
});

/** fetchInvoice is HTTP-only; loadInvoiceRows goes straight at the driver. Two
 *  queries of the same edit therefore report DIFFERENT labels on the data-access
 *  dimension, and the whole-body query (whose db.query evidence outweighs the
 *  fetches) reports "direct database calls" first. */
const MIXED_ACCESS = `export function fetchInvoice(id: string) {
  const res = fetch("/api/invoices/" + id);
  const meta = fetch("/api/invoices/" + id + "/meta");
  return [res, meta];
}
export function loadInvoiceRows(id: string) {
  const a = db.query("SELECT * FROM invoices WHERE id = $1", [id]);
  const b = db.query("SELECT * FROM invoice_lines WHERE invoice_id = $1", [id]);
  const c = db.query("SELECT * FROM invoice_taxes WHERE invoice_id = $1", [id]);
  return [a, b, c];
}`;

describe("the anchor names a construct that carried the flagged label", () => {
  it("pairs the site and the label from the SAME query on a multi-label axis", async () => {
    const rel = "src/billing/invoices.ts";
    const { open } = await raise("s-pairing", rel, MIXED_ACCESS);
    const arch = only(open, "architectural_consistency")[0];
    const anchor = arch.anchor!;
    expect(anchor.observed).toBe("direct database calls");

    // Whatever construct the anchor names, that construct's own body must be
    // what the stored label describes — otherwise the finding is anchored to
    // code that never carried the pattern, and any edit to it clears a finding
    // whose flagged code is untouched.
    const anchored =
      anchor.kind === "function"
        ? fileConstructs(rel, MIXED_ACCESS)!.bodies.get(anchor.symbol!)
        : MIXED_ACCESS;
    expect(anchored).toBeDefined();
    expect(classifyDataAccessLabel(anchored!, rel)).toBe(anchor.observed);
  });
});
