import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles, SKIP_DIRS } from "../../../src/core/discovery.js";
import { loadGitignore } from "../../../src/utils/gitignore.js";

/**
 * Issue #111: loadGitignore read only the ROOT .gitignore/.vibedriftignore,
 * so a monorepo scanned files that git itself ignores. Nested ignore files
 * must be honored, re-anchored to the directory they sit in — and must not
 * leak outside it.
 */
describe("discovery: nested ignore files (#111)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-nested-ignore-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (rel: string, content = "export const x = 1;\n") => {
    await mkdir(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...rel.split("/")), content);
  };

  it("honors a nested .gitignore, anchored to its own directory only", async () => {
    await put("packages/app/.gitignore", "generated/\n");
    await put("packages/app/generated/x.ts");
    await put("packages/app/real.ts");
    // A same-named dir OUTSIDE the nested file's scope must not be ignored.
    await put("other/generated/y.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("packages/app/real.ts");
    expect(names).not.toContain("packages/app/generated/x.ts");
    expect(names).toContain("other/generated/y.ts");
  });

  it("honors nested negation: re-included files inside an ignored glob scan", async () => {
    await put("packages/app/.gitignore", "scratch/*.ts\n!scratch/keepme.ts\n");
    await put("packages/app/scratch/a.ts");
    await put("packages/app/scratch/keepme.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).not.toContain("packages/app/scratch/a.ts");
    expect(names).toContain("packages/app/scratch/keepme.ts");
  });

  it("honors a nested .vibedriftignore and still honors the root files", async () => {
    await put(".gitignore", "rootignored/\n");
    await put("src/rootignored/z.ts");
    await put("packages/app/.vibedriftignore", "fixtures/\n");
    await put("packages/app/fixtures/f.ts");
    await put("src/keep.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("src/keep.ts");
    expect(names).not.toContain("src/rootignored/z.ts");
    expect(names).not.toContain("packages/app/fixtures/f.ts");
  });

  it("treats glob-metachar directory names literally: packages/[slug] (cross-review)", async () => {
    // A Next.js dynamic-route directory. Without escaping, the re-anchored
    // pattern's [slug] parses as a character class: it misses its own
    // directory AND wrongly ignores single-letter siblings like packages/s/.
    await put("packages/[slug]/.gitignore", "generated/\n");
    await put("packages/[slug]/generated/x.ts");
    await put("packages/[slug]/real.ts");
    await put("packages/s/generated/y.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).not.toContain("packages/[slug]/generated/x.ts");
    expect(names).toContain("packages/[slug]/real.ts");
    expect(names).toContain("packages/s/generated/y.ts");
  });

  it("treats a directory named !foo literally (no accidental negation)", async () => {
    await put("!foo/.gitignore", "ignored.ts\n");
    await put("!foo/ignored.ts");
    await put("!foo/kept.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).not.toContain("!foo/ignored.ts");
    expect(names).toContain("!foo/kept.ts");
  });

  it("parses CRLF ignore files", async () => {
    await put("packages/app/.gitignore", "generated/\r\n");
    await put("packages/app/generated/x.ts");
    await put("packages/app/keep/y.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).not.toContain("packages/app/generated/x.ts");
    expect(names).toContain("packages/app/keep/y.ts");
  });

  it("does not walk into skipped build dirs looking for ignore files", async () => {
    // An ignore file inside target/ can never apply (discovery skips target/),
    // so reading it only costs time. Observable proof the walk stayed out: its
    // pattern does not reach the matcher.
    await put("target/.gitignore", "*.ts\n");
    await put("src/a.ts");
    const ig = await loadGitignore(dir, SKIP_DIRS);
    expect(ig.ignores("target/x.ts")).toBe(false);
    // Callers that pass no skip set still get every nested file.
    expect((await loadGitignore(dir)).ignores("target/x.ts")).toBe(true);
  });
});
