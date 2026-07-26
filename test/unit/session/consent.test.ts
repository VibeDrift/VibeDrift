import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendConsentReceipt, CONSENT_LOG } from "@/session/consent";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-consent-")));

describe("consent receipts", () => {
  it("appends JSONL lines and creates the directory", () => {
    const dir = join(tmp(), "sessions", "hash");
    expect(appendConsentReceipt(dir, { v: 1, at: "t1", action: "enable", surface: "cli-enable", projectHash: "h" })).toBe(true);
    expect(appendConsentReceipt(dir, { v: 1, at: "t2", action: "decline", surface: "cli-decline", projectHash: "h" })).toBe(true);
    const lines = readFileSync(join(dir, CONSENT_LOG), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe("enable");
    expect(JSON.parse(lines[1]).action).toBe("decline");
  });

  it("uses the .log extension so the uploader (jsonl-only) never sees it", () => {
    expect(CONSENT_LOG.endsWith(".log")).toBe(true);
    expect(CONSENT_LOG.endsWith(".jsonl")).toBe(false);
  });
});
