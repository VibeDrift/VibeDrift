import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sumLocalLedgerTotals } from "@/session/trial-recap";

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
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 3, resolved: 1 });
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
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 1, resolved: 0 });
  });

  it("skips a corrupt line without losing the rest of the ledger", () => {
    const dir = tmp();
    mkdirSync(join(dir, "aaaa"), { recursive: true });
    writeFileSync(join(dir, "aaaa", "s1.jsonl"), ["{not json", flag("DF-1")].join("\n") + "\n");
    expect(sumLocalLedgerTotals(dir)).toEqual({ flagged: 1, resolved: 0 });
  });
});
