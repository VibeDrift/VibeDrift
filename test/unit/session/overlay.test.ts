import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  overlayEntriesFor,
  overlayEntriesExcept,
  overlayPath,
  readOverlay,
  updateOverlay,
  writeOverlay,
  OVERLAY_MAX_ENTRIES,
} from "@/session/overlay";
import { findSimilarToBody } from "@/codedna/find-similar-to-body";
import { buildBaseline } from "@/core/baseline";
import { runEditChecks, INLINE_CHECK_MAX_ENTRIES } from "@/session/check";

const MONTH_TITLE = `export function monthTitle(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}`;

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "vd-overlay-")));
}

describe("overlay index", () => {
  it("signs a file's functions the way the baseline does, and a clone in another file matches them", () => {
    const entries = overlayEntriesFor("src/a.tsx", MONTH_TITLE);
    expect(entries.map((e) => [e.relativePath, e.name, e.line])).toEqual([["src/a.tsx", "monthTitle", 1]]);
    const hits = findSimilarToBody(MONTH_TITLE, entries, { threshold: 0.8, cap: 3 });
    expect(hits[0]?.name).toBe("monthTitle");
    expect(hits[0]?.similarity).toBeGreaterThanOrEqual(0.99);
  });

  it("never lets a file match its own entries", () => {
    const o = updateOverlay({ files: new Map() }, "src/a.tsx", overlayEntriesFor("src/a.tsx", MONTH_TITLE));
    expect(overlayEntriesExcept(o, "src/a.tsx")).toEqual([]);
    expect(overlayEntriesExcept(o, "src/b.tsx").map((e) => e.name)).toEqual(["monthTitle"]);
  });

  it("replaces a file's entries on re-edit and evicts the oldest files past the cap", () => {
    let o = { files: new Map() } as ReturnType<typeof updateOverlay>;
    const one = overlayEntriesFor("src/x.ts", MONTH_TITLE);
    for (let i = 0; i < OVERLAY_MAX_ENTRIES + 5; i++) {
      o = updateOverlay(o, `src/f${String(i).padStart(4, "0")}.ts`, one.map((e) => ({ ...e, relativePath: `src/f${i}.ts` })));
    }
    let total = 0;
    for (const e of o.files.values()) total += e.length;
    expect(total).toBeLessThanOrEqual(OVERLAY_MAX_ENTRIES);
    expect(o.files.has("src/f0000.ts")).toBe(false); // oldest evicted
    expect(o.files.has(`src/f${String(OVERLAY_MAX_ENTRIES + 4).padStart(4, "0")}.ts`)).toBe(true);
    // re-editing a file replaces, never duplicates
    const before = o.files.size;
    o = updateOverlay(o, `src/f${String(OVERLAY_MAX_ENTRIES + 4).padStart(4, "0")}.ts`, []);
    expect(o.files.size).toBe(before - 1);
  });

  it("round-trips through the sidecar and reads a corrupt one as empty", async () => {
    const dir = tmp();
    const o = updateOverlay({ files: new Map() }, "src/a.tsx", overlayEntriesFor("src/a.tsx", MONTH_TITLE));
    await writeOverlay(dir, "hash1", "s1", o);
    const back = await readOverlay(dir, "hash1", "s1");
    expect([...back.files.keys()]).toEqual(["src/a.tsx"]);
    expect(back.files.get("src/a.tsx")![0].signature).toBeInstanceOf(Uint32Array);
    expect(back.files.get("src/a.tsx")![0].signature.length).toBe(o.files.get("src/a.tsx")![0].signature.length);
    writeFileSync(overlayPath(dir, "hash1", "s1"), "{ nope");
    expect((await readOverlay(dir, "hash1", "s1")).files.size).toBe(0);
    expect((await readOverlay(dir, "hash1", "never")).files.size).toBe(0);
  });
});

describe("overlay merge respects the inline gate", () => {
  it("fills only the headroom under INLINE_CHECK_MAX_ENTRIES, newest files first", async () => {
    const repo = tmp();
    const sessions = tmp();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
    const real = await buildBaseline(repo);
    // a baseline one entry under the gate: exactly one overlay entry fits
    const padded = { ...real, minhashIndex: Array.from({ length: INLINE_CHECK_MAX_ENTRIES - 1 }, (_, i) => ({ ...real.minhashIndex[0], relativePath: `pad/${i}.ts`, name: `pad${i}` })) };
    const older = overlayEntriesFor("src/older.tsx", MONTH_TITLE.replace("monthTitle", "olderTitle"));
    const newer = overlayEntriesFor("src/newer.tsx", MONTH_TITLE.replace("monthTitle", "newerTitle"));
    let o = updateOverlay({ files: new Map() }, "src/older.tsx", older);
    o = updateOverlay(o, "src/newer.tsx", newer);
    await writeOverlay(sessions, "hash1", "s1", o);
    const target = join(repo, "src", "target.tsx");
    writeFileSync(target, `${MONTH_TITLE}\n`);
    const out = await runEditChecks({
      rootDir: repo,
      projectHash: "hash1",
      sessionId: "s1",
      sessionsDir: sessions,
      file: target,
      body: MONTH_TITLE,
      loadBaselineFor: async () => padded,
    });
    const dup = out.flags.find((f) => f.detail.category === "redundancy");
    expect(dup?.detail.similarTo).toBe("src/newer.tsx:1"); // the older file fell outside the headroom
    expect(out.checked).toBe(true);
  }, 60_000);
});

