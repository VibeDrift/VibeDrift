import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readIntentState,
  writeIntentState,
  emptyIntentState,
  mergeIntentState,
  type IntentState,
} from "@/session/intent-state";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-intent-")));
const HASH = "hashhashhashhash";

describe("intent state", () => {
  it("round-trips state", async () => {
    const dir = tmp();
    const s = emptyIntentState();
    s.locked = true;
    s.task = "add webhook";
    s.anchors.files.push("routes/billing.ts");
    s.unrelatedEdits = 1;
    await writeIntentState(dir, HASH, "s1", s);
    const back = await readIntentState(dir, HASH, "s1");
    expect(back.locked).toBe(true);
    expect(back.task).toBe("add webhook");
    expect(back.anchors.files).toEqual(["routes/billing.ts"]);
    expect(back.unrelatedEdits).toBe(1);
  });

  it("returns an empty state when none exists (no throw)", async () => {
    const s = await readIntentState(tmp(), HASH, "none");
    expect(s).toEqual(emptyIntentState());
  });

  it("tolerates a corrupt state file", async () => {
    const dir = tmp();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, HASH), { recursive: true });
    writeFileSync(join(dir, HASH, "s1.intent.json"), "{ not json");
    expect(await readIntentState(dir, HASH, "s1")).toEqual(emptyIntentState());
  });
});

describe("mergeIntentState (pure)", () => {
  const base = (over: Partial<IntentState> = {}): IntentState => ({ ...emptyIntentState(), ...over });

  it("unions anchor files/symbols/tokens from both sides", () => {
    const local = base({ anchors: { files: ["a.ts"], symbols: ["foo"], tokens: ["bar"] } });
    const onDisk = base({ anchors: { files: ["b.ts"], symbols: ["baz"], tokens: ["bar"] } });
    const merged = mergeIntentState(local, onDisk);
    expect(merged.anchors.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(merged.anchors.symbols.sort()).toEqual(["baz", "foo"]);
    expect(merged.anchors.tokens).toEqual(["bar"]);
  });

  it("prefers locked=true from either side: an intent lock never un-locks from a stale read", () => {
    const locked = base({ locked: true, task: "add webhook" });
    const unlocked = base({ locked: false, task: "" });
    expect(mergeIntentState(unlocked, locked).locked).toBe(true);
    expect(mergeIntentState(locked, unlocked).locked).toBe(true);
  });

  it("takes the task label from whichever side actually locked", () => {
    const locked = base({ locked: true, task: "add webhook" });
    const unlocked = base({ locked: false, task: "" });
    expect(mergeIntentState(unlocked, locked).task).toBe("add webhook");
    expect(mergeIntentState(locked, unlocked).task).toBe("add webhook");
  });

  it("takes the max unrelatedEdits counter from either side", () => {
    const local = base({ unrelatedEdits: 1 });
    const onDisk = base({ unrelatedEdits: 3 });
    expect(mergeIntentState(local, onDisk).unrelatedEdits).toBe(3);
  });

  it("unions scopeFlagged files from both sides without duplicates", () => {
    const local = base({ scopeFlagged: ["x.ts", "y.ts"] });
    const onDisk = base({ scopeFlagged: ["y.ts", "z.ts"] });
    expect(mergeIntentState(local, onDisk).scopeFlagged.sort()).toEqual(["x.ts", "y.ts", "z.ts"]);
  });
});

describe("writeIntentState: a later write merges with, rather than clobbers, an earlier one", () => {
  it("a second write for the same session keeps the first write's locked task and anchors", async () => {
    const dir = tmp();
    const first: IntentState = { ...emptyIntentState(), locked: true, task: "add webhook", anchors: { files: ["routes/billing.ts"], symbols: [], tokens: [] } };
    await writeIntentState(dir, HASH, "s-seq", first);

    // second write computed from a stale (pre-lock) read, as a concurrent
    // writer's would be — it never saw the lock or the anchor file.
    const second: IntentState = { ...emptyIntentState(), unrelatedEdits: 1 };
    await writeIntentState(dir, HASH, "s-seq", second);

    const final = await readIntentState(dir, HASH, "s-seq");
    expect(final.locked).toBe(true);
    expect(final.task).toBe("add webhook");
    expect(final.anchors.files).toEqual(["routes/billing.ts"]);
    expect(final.unrelatedEdits).toBe(1);
  });
});
