import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "../../../src/core/discovery.js";

/**
 * Issue #110: discovery dropped a whole file when ONE line passed the 2000-char
 * cap — a rule meant for minified bundles like a checked-in ace.js — and said
 * nothing when it did. The two sibling exclusions (vendored filename regex,
 * file-size cap) were equally silent.
 *
 * Post-fix: a file is dropped as a bundle only when its over-cap lines carry
 * at least half of its bytes (a hand-written file with one long inline SVG path
 * or type union is kept), and every exclusion is recorded in DiscoveryWarnings
 * with its reason so the scan can say what it skipped.
 */
describe("discovery: one long line must not vanish a hand-written file (#110)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-excluded-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a hand-written file with one very long line (inline SVG path)", async () => {
    // A realistic component: a few hundred lines of ordinary code (~7 KB) and
    // one ~2.6 KB inline SVG path. The old rule dropped the whole file for
    // that one line; the bundle rule must not (the long line is a minority of
    // the file's bytes).
    const normal = Array.from({ length: 200 }, (_, i) => `export function handler${i}(req: Req) { return route(${i}); }`).join("\n");
    const svgPath = `const ICON_PATH = "${"M10 10 L20 20 ".repeat(200)}";`; // ~2600 chars, one line
    await writeFile(join(dir, "icon.ts"), `${normal}\n${svgPath}\n`);
    const { files } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).toContain("icon.ts");
  });

  it("still drops a real minified bundle with no marker in its name", async () => {
    await writeFile(join(dir, "ace.js"), "var ACE=(function(){" + "a=a+1;".repeat(600) + "})();\n");
    const { files, warnings } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).not.toContain("ace.js");
    expect(warnings.excludedFiles).toContainEqual({ path: "ace.js", reason: "minified_bundle" });
  });

  it("records the vendored-filename exclusion", async () => {
    await writeFile(join(dir, "jquery-3.2.1.min.js"), "var x=1;\n");
    const { warnings } = await discoverFiles(dir);
    expect(warnings.excludedFiles).toContainEqual({ path: "jquery-3.2.1.min.js", reason: "vendored" });
  });

  it("records the file-size-cap exclusion", async () => {
    // MAX_FILE_SIZE is 1 MiB; a source file past it is skipped and now recorded.
    await writeFile(join(dir, "huge.ts"), "export const x = 1;\n" + "// pad\n".repeat(160_000));
    const { files, warnings } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).not.toContain("huge.ts");
    expect(warnings.excludedFiles).toContainEqual({ path: "huge.ts", reason: "too_large" });
  });

  it("keeps a file with several long lines when they are still a minority of its bytes", async () => {
    const normal = Array.from({ length: 120 }, (_, i) => `export const row${i} = ${i};`).join("\n");
    const unions = ["A", "B", "C"].map((n) => `export type Union${n} = "${Array.from({ length: 60 }, (_, i) => `value-${n}-${i}`).join('" | "')}";`).join("\n");
    await writeFile(join(dir, "unions.ts"), `${normal}\n${unions}\n`);
    const { files } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).toContain("unions.ts");
  });

  it("keeps an empty file (the long-line guard must not fire on 0 bytes)", async () => {
    await writeFile(join(dir, "empty.ts"), "");
    const { files } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).toContain("empty.ts");
  });

  it("boundary: a 2000-char line is under the cap, a 2001-char line is over", async () => {
    const at = `export const at = "${"a".repeat(2000 - 21)}";`; // line length exactly 2000
    const over = `export const over = "${"b".repeat(2001 - 23)}";`; // line length exactly 2001
    // both files are single-line => over-cap bytes would be 100% of the file,
    // so "over" drops as bundle-shaped and "at" is kept on the length check alone
    await writeFile(join(dir, "at.ts"), `${at}\n`);
    await writeFile(join(dir, "over.ts"), `${over}\n`);
    const { files, warnings } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("at.ts");
    expect(names).not.toContain("over.ts");
    expect(warnings.excludedFiles).toContainEqual({ path: "over.ts", reason: "minified_bundle" });
  });

  it("pins the residual shape: a file that is mostly one long line still drops, recorded", async () => {
    // A one-line, hand-written 2.6 KB type union is NOT a minified bundle, but
    // its long line IS the file, so the bundle rule drops it. This pins the
    // accepted residual of the majority-of-bytes rule: such files are now at
    // least recorded and reported, never silent (reviewer R2).
    const union = `export type Big = "${Array.from({ length: 180 }, (_, i) => `value-${i}`).join('" | "')}";`;
    await writeFile(join(dir, "big-union.ts"), `${union}\n`);
    const { files, warnings } = await discoverFiles(dir);
    expect(files.map((f) => f.relativePath)).not.toContain("big-union.ts");
    expect(warnings.excludedFiles).toContainEqual({ path: "big-union.ts", reason: "minified_bundle" });
  });
});
