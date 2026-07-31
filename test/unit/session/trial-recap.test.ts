import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sumLocalLedgerTotals,
  RECAP_MAX_FILES,
  RECAP_MAX_FILE_BYTES,
  RECAP_MAX_TOTAL_BYTES,
} from "@/session/trial-recap";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vd-recap-"));
}

/** One serialized ledger event with the boilerplate fields filled in. */
function ev(over: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    sid: "s1",
    aid: "a1",
    ts: "2026-07-30T00:00:00.000Z",
    agent: "claude-code",
    projectHash: "p",
    channel: "hook",
    mode: "passive",
    detail: {},
    ...over,
  });
}

const flag = (id: string): string => ev({ type: "flag", findingId: id, detail: { file: "x.ts", category: "naming" } });
const resolve = (id: string): string => ev({ type: "resolve", findingId: id, detail: { file: "x.ts", category: "naming" } });

describe("sumLocalLedgerTotals", () => {
  it("sums flagged and resolved across every project's ledgers", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    mkdirSync(join(dir, "bbbb"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), [flag("DF-1"), flag("DF-2"), resolve("DF-1")].join("\n") + "\n");
    writeFileSync(join(dir, "bbbb", "s1.jsonl"), flag("DF-1") + "\n");
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 3, resolved: 1, complete: true });
  });

  it("returns null when the sessions dir does not exist", () => {
    expect(sumLocalLedgerTotals(join(tmp(), "never-written"))).toBeNull();
  });

  it("returns null when no ledger files exist", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    expect(sumLocalLedgerTotals(dir)).toBeNull();
  });

  it("returns null when the only ledger is unreadable (never a guessed count)", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    const file = join(dir, "aaaa", "s1.jsonl");
    writeFileSync(file, flag("DF-1") + "\n");
    chmodSync(file, 0o000);
    expect(sumLocalLedgerTotals(dir)).toBeNull();
  });

  it("counts only session ledgers, never sidecar or consent files", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), flag("DF-1") + "\n");
    writeFileSync(join(dir, "aaaa", "consent.log"), ev({ type: "flag", findingId: "DF-9" }) + "\n");
    writeFileSync(join(dir, "aaaa", "s1.outcomes.json"), "{}");
    writeFileSync(join(dir, "aaaa", "s1.intent.json"), "{}");
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 1, resolved: 0, complete: true });
  });

  it("skips a corrupt line without losing the rest of the ledger", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), ["{not json", flag("DF-1")].join("\n") + "\n");
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 1, resolved: 0, complete: true });
  });

  it("excludes experimental signals from the totals", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(
      join(dir, "aaaa", "s1.jsonl"),
      ev({ type: "flag", findingId: "DF-1", detail: { file: "x.ts", category: "scope", experimental: true } }) + "\n",
    );
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 0, resolved: 0, complete: true });
  });

  it("returns null once the file budget is exceeded (sync walk stays bounded)", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, "aaaa", `s${i}.jsonl`), flag("DF-1") + "\n");
    expect(sumLocalLedgerTotals(dir, { maxFiles: 3 })).toBeNull();
  });

  it("returns null once the total byte budget is exceeded", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), flag("DF-1") + "\n");
    writeFileSync(join(dir, "aaaa", "s2.jsonl"), flag("DF-1") + "\n");
    expect(sumLocalLedgerTotals(dir, { maxTotalBytes: 200 })).toBeNull();
  });

  it("skips an oversized ledger and reports the read as partial", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    // ten flag lines put big.jsonl well over the tiny test cap
    writeFileSync(join(dir, "aaaa", "big.jsonl"), Array(10).fill(flag("DF-1")).join("\n") + "\n");
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), ev({ type: "flag", findingId: "DF-2", detail: { file: "y.ts", category: "naming" } }) + "\n");
    expect(sumLocalLedgerTotals(dir, { maxFileBytes: 500 })).toEqual({ flagged: 1, resolved: 0, complete: false });
  });

  it("marks a per-file read error as a partial read", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), flag("DF-1") + "\n");
    const broken = join(dir, "aaaa", "s2.jsonl");
    writeFileSync(broken, flag("DF-2") + "\n");
    chmodSync(broken, 0o000);
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 1, resolved: 0, complete: false });
  });

  it("pins the default budgets", () => {
    expect(RECAP_MAX_FILES).toBe(200);
    expect(RECAP_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(RECAP_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024);
  });
});
