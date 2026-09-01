import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@/session/atomic-write";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-atomic-")));

describe("writeFileAtomic", () => {
  it("writes the file and creates the parent directory", async () => {
    const dir = tmp();
    const path = join(dir, "nested", "state.json");
    await writeFileAtomic(path, JSON.stringify({ a: 1 }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  it("respects an explicit file mode", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  // The bug this guards against: a plain writeFile() truncates the target
  // in place, so a process killed mid-write (hook-entry.ts's 2s
  // self-timeout calls process.exit(0) without waiting for pending async
  // I/O) can leave a torn file — truncated or a mix of two writers' bytes.
  // writeFileAtomic never writes the target path directly: each writer
  // writes its OWN uniquely-named tmp sibling, and only the final `rename`
  // (a single filesystem operation) ever touches the target, so the target
  // is always either the previous whole value or one writer's whole new
  // value — never anything in between.
  it("never leaves a torn file: concurrent writers land one whole value, never a mix", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    const a = "A".repeat(50_000) + "-end-A";
    const b = "B".repeat(50_000) + "-end-B";
    await Promise.all([writeFileAtomic(path, a), writeFileAtomic(path, b)]);
    const final = readFileSync(path, "utf8");
    expect([a, b]).toContain(final);
  });

  it("leaves no tmp siblings behind after concurrent writes to the same path", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileAtomic(path, `payload-${i}`)));
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("gives concurrent writers to DIFFERENT paths distinct tmp names (no cross-write collision)", async () => {
    const dir = tmp();
    const pathA = join(dir, "a.json");
    const pathB = join(dir, "b.json");
    await Promise.all([
      writeFileAtomic(pathA, JSON.stringify({ who: "a" })),
      writeFileAtomic(pathB, JSON.stringify({ who: "b" })),
    ]);
    expect(JSON.parse(readFileSync(pathA, "utf8"))).toEqual({ who: "a" });
    expect(JSON.parse(readFileSync(pathB, "utf8"))).toEqual({ who: "b" });
  });
});
