import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIntentState, writeIntentState, emptyIntentState } from "@/session/intent-state";

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
