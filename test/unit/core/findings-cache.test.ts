import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  computeAnalyzerCacheKey,
  filterApplicableFiles,
  loadAnalyzerFindings,
  saveAnalyzerFindings,
  pruneCache,
} from "../../../src/core/findings-cache.js";
import type { Finding, SourceFile } from "../../../src/core/types.js";
import { homedir } from "os";
import { createHash } from "crypto";

function projectHash(rootDir: string): string {
  return createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
}

function cacheDirFor(rootDir: string): string {
  return join(homedir(), ".vibedrift", "findings-cache", projectHash(rootDir));
}

function makeFile(relativePath: string, content: string, language: SourceFile["language"] = "typescript"): SourceFile {
  return {
    path: "/abs/" + relativePath,
    relativePath,
    language,
    content,
    lineCount: content.split("\n").length,
  };
}

function makeFinding(msg = "test finding"): Finding {
  return {
    analyzerId: "test-analyzer",
    severity: "warning",
    confidence: 0.8,
    message: msg,
    locations: [{ file: "a.ts", line: 1 }],
    tags: ["test"],
  };
}

describe("findings-cache", () => {
  // Each test uses a unique rootDir so parallel vitest workers don't collide.
  // We clean the matching cache dir in afterEach, not the rootDir (which is
  // never actually written to — the cache lives in ~/.vibedrift).
  let rootDir: string;

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rootDir = await mkdtemp(join(tmpdir(), `vd-cache-test-${stamp}-`));
  });

  afterEach(async () => {
    // Clean the cache entry for this test
    await rm(cacheDirFor(rootDir), { recursive: true, force: true });
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("computeAnalyzerCacheKey", () => {
    it("produces the same key for the same inputs", () => {
      const files = [makeFile("a.ts", "const x = 1;"), makeFile("b.ts", "const y = 2;")];
      const k1 = computeAnalyzerCacheKey("security", 1, files);
      const k2 = computeAnalyzerCacheKey("security", 1, files);
      expect(k1).toBe(k2);
    });

    it("differs when file content changes", () => {
      const k1 = computeAnalyzerCacheKey("security", 1, [makeFile("a.ts", "const x = 1;")]);
      const k2 = computeAnalyzerCacheKey("security", 1, [makeFile("a.ts", "const x = 2;")]);
      expect(k1).not.toBe(k2);
    });

    it("differs when analyzer version is bumped", () => {
      const files = [makeFile("a.ts", "const x = 1;")];
      expect(computeAnalyzerCacheKey("security", 1, files)).not.toBe(
        computeAnalyzerCacheKey("security", 2, files),
      );
    });

    it("differs when analyzer id changes", () => {
      const files = [makeFile("a.ts", "const x = 1;")];
      expect(computeAnalyzerCacheKey("security", 1, files)).not.toBe(
        computeAnalyzerCacheKey("complexity", 1, files),
      );
    });

    it("is order-insensitive across files", () => {
      const a = makeFile("a.ts", "const x = 1;");
      const b = makeFile("b.ts", "const y = 2;");
      expect(computeAnalyzerCacheKey("security", 1, [a, b])).toBe(
        computeAnalyzerCacheKey("security", 1, [b, a]),
      );
    });
  });

  describe("filterApplicableFiles", () => {
    it("returns all language-typed files when applicableLanguages is 'all'", () => {
      const files = [
        makeFile("a.ts", "x", "typescript"),
        makeFile("b.py", "x", "python"),
        { ...makeFile("c.txt", "x"), language: null },
      ];
      expect(filterApplicableFiles(files, "all")).toHaveLength(2);
    });

    it("filters to the specified languages", () => {
      const files = [
        makeFile("a.ts", "x", "typescript"),
        makeFile("b.py", "x", "python"),
        makeFile("c.go", "x", "go"),
      ];
      const result = filterApplicableFiles(files, ["typescript", "go"]);
      expect(result.map((f) => f.relativePath).sort()).toEqual(["a.ts", "c.go"]);
    });
  });

  describe("save + load round-trip", () => {
    it("returns null on cache miss", async () => {
      const result = await loadAnalyzerFindings(rootDir, "nonexistent-key");
      expect(result).toBeNull();
    });

    it("round-trips findings correctly", async () => {
      const key = "abc123";
      const findings = [makeFinding("a"), makeFinding("b")];
      await saveAnalyzerFindings(rootDir, key, findings);
      const loaded = await loadAnalyzerFindings(rootDir, key);
      expect(loaded).toEqual(findings);
    });

    it("different content produces different key → cache miss on change", async () => {
      const files1 = [makeFile("a.ts", "const x = 1;")];
      const files2 = [makeFile("a.ts", "const x = 2;")];
      const key1 = computeAnalyzerCacheKey("security", 1, files1);
      const key2 = computeAnalyzerCacheKey("security", 1, files2);
      await saveAnalyzerFindings(rootDir, key1, [makeFinding("v1")]);
      expect(await loadAnalyzerFindings(rootDir, key2)).toBeNull();
    });

    it("version bump invalidates the cache", async () => {
      const files = [makeFile("a.ts", "const x = 1;")];
      const keyV1 = computeAnalyzerCacheKey("security", 1, files);
      const keyV2 = computeAnalyzerCacheKey("security", 2, files);
      await saveAnalyzerFindings(rootDir, keyV1, [makeFinding("v1 output")]);
      expect(await loadAnalyzerFindings(rootDir, keyV2)).toBeNull();
    });
  });

  describe("pruneCache", () => {
    it("does nothing when the cache dir doesn't exist", async () => {
      await expect(pruneCache(rootDir)).resolves.toBeUndefined();
    });

    it("deletes entries older than the TTL", async () => {
      const key = "old-entry";
      await saveAnalyzerFindings(rootDir, key, [makeFinding()]);
      const path = join(cacheDirFor(rootDir), `${key}.json`);
      // Age the file past the 30-day TTL
      const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      await utimes(path, old, old);

      await pruneCache(rootDir);

      const files = await readdir(cacheDirFor(rootDir)).catch(() => []);
      expect(files).not.toContain(`${key}.json`);
    });

    it("keeps fresh entries", async () => {
      const key = "fresh-entry";
      await saveAnalyzerFindings(rootDir, key, [makeFinding()]);
      await pruneCache(rootDir);
      const files = await readdir(cacheDirFor(rootDir));
      expect(files).toContain(`${key}.json`);
    });
  });

  describe("cache directory is isolated per project", () => {
    it("different rootDirs don't collide", async () => {
      const other = await mkdtemp(join(tmpdir(), "vd-cache-other-"));
      try {
        const key = "shared-key";
        await saveAnalyzerFindings(rootDir, key, [makeFinding("A")]);
        await saveAnalyzerFindings(other, key, [makeFinding("B")]);

        const loadedA = await loadAnalyzerFindings(rootDir, key);
        const loadedB = await loadAnalyzerFindings(other, key);
        expect(loadedA?.[0].message).toBe("A");
        expect(loadedB?.[0].message).toBe("B");
      } finally {
        await rm(cacheDirFor(other), { recursive: true, force: true });
        await rm(other, { recursive: true, force: true });
      }
    });
  });

});
