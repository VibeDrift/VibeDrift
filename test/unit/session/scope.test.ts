import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processPrompt, checkScope } from "@/session/scope";
import { readIntentState } from "@/session/intent-state";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-scope-")));
const HASH = "hashhashhashhash";

describe("processPrompt", () => {
  it("locks on the first prompt, and emits an expansion carrying all files when a follow-up adds one", async () => {
    const dir = tmp();
    const lock = await processPrompt(dir, HASH, "s1", "add webhook to routes/billing.ts using `handleStripeWebhook`");
    expect(lock?.type).toBe("intent_lock");
    expect(lock?.detail.observed).toBe(""); // first lock
    expect(lock?.detail.promptText).toContain("webhook");

    const expanded = await processPrompt(dir, HASH, "s1", "also touch routes/orders.ts");
    expect(expanded?.type).toBe("intent_lock");
    expect(expanded?.detail.observed).toBe("expanded");
    // the expansion event carries the FULL current file set (for coverage)
    expect(expanded?.detail.anchorFiles).toEqual(
      expect.arrayContaining(["routes/billing.ts", "routes/orders.ts"]),
    );

    // a prompt that adds no new files emits nothing
    const noop = await processPrompt(dir, HASH, "s1", "make it clean");
    expect(noop).toBeNull();

    const state = await readIntentState(dir, HASH, "s1");
    expect(state.anchors.files).toEqual(expect.arrayContaining(["routes/billing.ts", "routes/orders.ts"]));
  });

  it("does not lock on a whitespace-only first prompt", async () => {
    const dir = tmp();
    expect(await processPrompt(dir, HASH, "s1", "   \n  ")).toBeNull();
    expect((await readIntentState(dir, HASH, "s1")).locked).toBe(false);
  });
});

describe("checkScope", () => {
  async function lock(dir: string) {
    await processPrompt(dir, HASH, "s1", "add webhook handling to routes/billing.ts using `handleStripeWebhook`");
  }

  it("does NOT flag a single unrelated edit (conservative)", async () => {
    const dir = tmp();
    await lock(dir);
    const r = await checkScope(dir, HASH, "s1", "ui/theme.ts", "const palette = { red: 1 };");
    expect(r.flag).toBeNull();
    expect(r.fyi).toBeNull();
  });

  it("flags the SECOND unrelated edit as experimental scope drift", async () => {
    const dir = tmp();
    await lock(dir);
    await checkScope(dir, HASH, "s1", "ui/theme.ts", "const palette = { red: 1 };"); // 1st unrelated
    const r = await checkScope(dir, HASH, "s1", "ui/layout.ts", "const grid = 12;"); // 2nd unrelated
    expect(r.flag?.type).toBe("flag");
    expect(r.flag?.detail.category).toBe("scope");
    expect(r.flag?.detail.experimental).toBe(true);
    expect(r.fyi).toBeTruthy();
    expect(r.fyi!.toLowerCase()).toContain("experimental");
  });

  it("does NOT count a related edit toward the unrelated tally", async () => {
    const dir = tmp();
    await lock(dir);
    await checkScope(dir, HASH, "s1", "ui/theme.ts", "const x = 1;"); // 1 unrelated
    await checkScope(dir, HASH, "s1", "routes/billing.ts", "handleStripeWebhook()"); // related, not counted
    const r = await checkScope(dir, HASH, "s1", "docs/readme.md", "hello"); // 2nd unrelated -> flag
    expect(r.flag).toBeTruthy();
  });

  it("is a no-op before intent is locked", async () => {
    const dir = tmp();
    const r = await checkScope(dir, HASH, "s1", "anything.ts", "x");
    expect(r.flag).toBeNull();
  });

  it("does not re-flag the same file twice", async () => {
    const dir = tmp();
    await lock(dir);
    await checkScope(dir, HASH, "s1", "a.ts", "x"); // 1
    const first = await checkScope(dir, HASH, "s1", "b.ts", "y"); // 2 -> flag
    expect(first.flag).toBeTruthy();
    const again = await checkScope(dir, HASH, "s1", "b.ts", "y2"); // same file
    expect(again.flag).toBeNull();
  });
});
