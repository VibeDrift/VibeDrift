import { describe, it, expect } from "vitest";
import { extractAnchors, mergeAnchors, editRelatesToAnchors, taskSummary } from "@/session/anchors";

describe("extractAnchors", () => {
  it("pulls file paths, backticked symbols, and identifier tokens", () => {
    const a = extractAnchors(
      "add Stripe webhook handling to routes/billing.ts, reuse `handleStripeWebhook`, follow requireAuth",
    );
    expect(a.files).toContain("routes/billing.ts");
    expect(a.symbols).toContain("handleStripeWebhook");
    expect(a.tokens).toContain("stripe");
    expect(a.tokens).toContain("webhook");
    // stopwords / short words dropped
    expect(a.tokens).not.toContain("add");
    expect(a.tokens).not.toContain("to");
  });

  it("captures dotted filenames without a slash", () => {
    expect(extractAnchors("update package.json and tsconfig.json").files).toEqual(
      expect.arrayContaining(["package.json", "tsconfig.json"]),
    );
  });

  it("does not double-count a path and its bare basename", () => {
    // "routes/billing.ts" must not also yield a separate "billing.ts"
    expect(extractAnchors("edit routes/billing.ts now").files).toEqual(["routes/billing.ts"]);
  });

  it("does not treat prose slashes (async/await, and/or) as files", () => {
    const a = extractAnchors("use async/await in src/api/reports.ts and/or fix it");
    expect(a.files).toEqual(["src/api/reports.ts"]);
  });
});

describe("mergeAnchors", () => {
  it("unions and dedupes so follow-up prompts extend", () => {
    const a = extractAnchors("work on routes/billing.ts with `formatMoney`");
    const b = extractAnchors("also touch routes/orders.ts and `formatMoney`");
    const m = mergeAnchors(a, b);
    expect(m.files).toEqual(expect.arrayContaining(["routes/billing.ts", "routes/orders.ts"]));
    expect(m.symbols.filter((s) => s === "formatMoney")).toHaveLength(1);
  });
});

describe("editRelatesToAnchors", () => {
  const anchors = extractAnchors("add webhook handling to routes/billing.ts using `handleStripeWebhook`");

  it("relates when the file matches an anchor path", () => {
    expect(editRelatesToAnchors("routes/billing.ts", "export function x(){}", anchors)).toBe(true);
  });
  it("relates when the body contains an anchor symbol", () => {
    expect(editRelatesToAnchors("lib/other.ts", "handleStripeWebhook()", anchors)).toBe(true);
  });
  it("relates when it shares an identifier token", () => {
    expect(editRelatesToAnchors("lib/hooks.ts", "function webhookRouter(){}", anchors)).toBe(true);
  });
  it("does NOT relate for an unrelated edit", () => {
    expect(editRelatesToAnchors("ui/theme.ts", "const palette = { red: 1 };", anchors)).toBe(false);
  });

  it("does NOT relate a REAL code body that only shares generic keywords", () => {
    // the review's example: a logger with return/error/export must be UNRELATED
    const a = extractAnchors("Update the User profile page to return an Error on failure");
    const logger = "export function log(msg: string) { return console.error(msg); }";
    expect(editRelatesToAnchors("lib/logger.ts", logger, a)).toBe(false);
    const cache = "export function get(k: string) { return store.get(k); }";
    expect(editRelatesToAnchors("lib/cache.ts", cache, a)).toBe(false);
  });

  it("does not match a.ts against banana.ts (bounded file suffix)", () => {
    const a = extractAnchors("edit a.ts");
    expect(editRelatesToAnchors("src/banana.ts", "x", a)).toBe(false);
  });

  it("does not treat bare Capitalized prose words as symbols", () => {
    const a = extractAnchors("Update the Profile and return an Error");
    // "Error"/"Update"/"Profile" are prose, not code anchors
    expect(a.symbols).not.toContain("Error");
    expect(a.symbols).not.toContain("Update");
  });
});

describe("taskSummary", () => {
  it("is a short single-line gist of the prompt", () => {
    const s = taskSummary("add Stripe webhook handling to the billing route\nand follow the auth pattern");
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).not.toContain("\n");
    expect(s.toLowerCase()).toContain("stripe");
  });
});
