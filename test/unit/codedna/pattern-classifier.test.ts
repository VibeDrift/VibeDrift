import { describe, it, expect } from "vitest";
import { classifyPatterns, patternFindings } from "../../../src/codedna/pattern-classifier.js";
import type { SourceFile, SupportedLanguage } from "../../../src/core/types.js";

/**
 * Regression tests for issue #87 — the data-access pattern classifier labelling
 * files "orm" when no ORM is present.
 *
 * Two independent defects are covered here:
 *
 *   1. The ORM signal regex carried a bare `ent\.` alternative with no left
 *      boundary, so any identifier ending in the letters "ent" plus a dot was
 *      read as an Ent ORM usage. `file.content.split(...)` was enough.
 *   2. `isHandlerOrServiceFile` matched its tokens as unanchored substrings, so
 *      "route" inside "router"/"autorouter"/"route-extractors" and "api" inside
 *      "therapist"/"capital" admitted files that are not handlers.
 *
 * Before the fix, scanning this repository against itself reported
 * "Pattern drift: src/auth/api.ts uses http_client while 5/6 files use orm"
 * at confidence 1.0, with no ORM in package.json.
 */

const file = (relativePath: string, content: string, language: SupportedLanguage = "typescript"): SourceFile => ({
  path: `/repo/${relativePath}`,
  relativePath,
  language,
  content,
  lineCount: content.split("\n").length,
});

/** Classify a single body at a path that clears the handler/service gate. */
function patternsFor(content: string, language: SupportedLanguage = "typescript", path = "src/handlers/data.ts"): string[] {
  const dists = classifyPatterns([file(path, content, language)]);
  return dists.length === 0 ? [] : Object.keys(dists[0].patterns);
}

const hasOrm = (content: string, language: SupportedLanguage = "typescript", path?: string): boolean =>
  patternsFor(content, language, path).includes("orm");

describe("pattern-classifier ORM signal (issue #87)", () => {
  describe("true positives: real ORM usage must still be detected", () => {
    const cases: Array<[string, string, SupportedLanguage]> = [
      ["gorm package selector", 'db := gorm.Open(postgres.Open(dsn))', "go"],
      ["prisma lowercase client", "const items = await prisma.post.findMany({ where: { published: true } });", "typescript"],
      ["prisma capitalized namespace import", "import type { Prisma } from '@prisma/client';", "typescript"],
      ["prisma type position", "} satisfies Prisma.PostSelect;", "typescript"],
      ["sequelize require", 'const Sequelize = require("sequelize");', "javascript"],
      ["typeorm import", 'import { getRepository } from "typeorm";', "typescript"],
      ["sqlalchemy import", "from sqlalchemy.orm import Session", "python"],
      ["django.db import", "from django.db import models", "python"],
      ["Ent client type", "var client *ent.Client", "go"],
      ["Ent constructor", "client := ent.NewClient(ent.Driver(drv))", "go"],
      ["Ent open", 'c, err := ent.Open("postgres", dsn)', "go"],
      ["Ent error helper", "if ent.IsNotFound(err) { return nil }", "go"],
      ["Ent generated entity slice", "func all(ctx context.Context) ([]*ent.User, error) {", "go"],
      ["Ent generated entity pointer", "func one(ctx context.Context) (*ent.User, error) {", "go"],
      ["Ent transaction type", "var t *ent.Tx", "go"],
    ];

    for (const [name, line, language] of cases) {
      it(`keeps ${name}`, () => {
        expect(hasOrm(line, language)).toBe(true);
      });
    }
  });

  describe("true negatives: identifiers merely ending in 'ent' are not an ORM", () => {
    const cases: Array<[string, string]> = [
      ["content.", 'const lines = file.content.split("\\n");'],
      ["fullContent.", "const idx = fullContent.indexOf(routePath);"],
      ["client.", "const res = client.send(req);"],
      ["httpClient.", "httpClient.get(url)"],
      ["component.", "component.render()"],
      ["current.", "current.next = null"],
      ["agent.", "agent.run()"],
      ["environment.", "environment.NODE_ENV"],
      ["argument.", "argument.value"],
      ["management.", "management.list()"],
      ["document.", 'const doc = document.getElementById("x");'],
      ["event.", "switch (event.type) {"],
      ["parent.", "parent.appendChild(node)"],
    ];

    for (const [name, line] of cases) {
      it(`does not read ${name} as an ORM`, () => {
        expect(hasOrm(line)).toBe(false);
      });
    }
  });

  describe("Ent boundary cases", () => {
    it("matches ent. at the start of a line", () => {
      expect(hasOrm("ent.Client{}", "go")).toBe(true);
    });

    it("does not match a snake_case alias", () => {
      // `_` is a word character, so there is no \b between "some_" and "ent".
      expect(hasOrm("x := some_ent.Client{}", "go")).toBe(false);
    });

    it("does not match a camelCase alias (documented recall gap)", () => {
      // Accepted limitation: the generated Ent package is named `ent` by default,
      // so an aliased import is not recognised. Widening this needs an import table.
      expect(hasOrm("var c *myent.Client = newClient()", "go")).toBe(false);
    });

    it("does not match a lowercase field after ent (Rust local variable)", () => {
      expect(hasOrm("return ent.ty.clone();", "rust")).toBe(false);
    });

    it("does not match a lowercase field after ent (TS local variable)", () => {
      expect(hasOrm("if (ent && !ent.entitled) {")).toBe(false);
    });

    it("does not match uppercase ENT.", () => {
      // The Ent definition is case-sensitive on purpose; the /i alternation above
      // it no longer contains "ent" at all.
      expect(hasOrm("ENT.Client", "go")).toBe(false);
    });

    it("does not match entity.", () => {
      expect(hasOrm("entity.save()")).toBe(false);
    });

    it("does not match the entgo.io import path", () => {
      // Pre-existing behaviour, pinned so that changing it is a deliberate act.
      expect(hasOrm('import "entgo.io/ent"', "go")).toBe(false);
    });

    it("still matches inside a string literal (line regex, not AST)", () => {
      // Accepted behaviour: the classifier is line-based, so it cannot tell code
      // from a string. Pinned so the limitation is visible rather than surprising.
      expect(hasOrm('const s = "ent.Client";')).toBe(true);
    });

    it("still matches inside a comment (line regex, not AST)", () => {
      expect(hasOrm("// use ent.Client here")).toBe(true);
    });

    it("leaves the untouched alternation alone (gorm2 still matches)", () => {
      // Proves the fix is scoped to the Ent alternative only.
      expect(hasOrm("gorm2.Open()", "go")).toBe(true);
    });
  });

  describe("production-shaped file", () => {
    it("classifies an HTTP handler that merely reads file.content as http_client, not orm", () => {
      const body = [
        'import { readFileSync } from "node:fs";',
        'import { logger } from "../logger.js";',
        "",
        "export async function loadOrder(id: string): Promise<Order> {",
        "  logger.info(`loading order ${id}`);",
        "  const res = await fetch(`https://api.example.com/orders/${id}`);",
        "  if (!res.ok) throw new Error(`order ${id} failed: ${res.status}`);",
        "  return (await res.json()) as Order;",
        "}",
        "",
        "export function summarize(file: { content: string }): string[] {",
        '  const lines = file.content.split("\\n");',
        "  return lines.filter((l) => l.trim().length > 0);",
        "}",
      ].join("\n");

      const patterns = patternsFor(body);
      expect(patterns).toContain("http_client");
      expect(patterns).not.toContain("orm");
    });
  });

  describe("handler/service path gate matches segments, not substrings", () => {
    // Every input carries one unambiguous signal, so classification depends
    // only on the gate.
    const BODY = "await fetch(url);";
    const classified = (path: string): boolean => classifyPatterns([file(path, BODY)]).length > 0;

    const rejected = [
      ["autorouter.ts", "src/autorouter.ts"],
      ["AutoRouter.ts", "src/AutoRouter.ts"],
      ["itty-router.js", "benchmarks/webapp/itty-router.js"],
      ["route-extractors", "src/drift/route-extractors/go.ts"],
      ["therapist.ts (api substring)", "src/therapist.ts"],
      ["capital.ts (api substring)", "src/capital.ts"],
      ["rapid.ts (api substring)", "src/rapid.ts"],
      ["serviceable.ts", "src/serviceable.ts"],
    ] as const;

    for (const [name, path] of rejected) {
      it(`rejects ${name}`, () => {
        expect(classified(path)).toBe(false);
      });
    }

    const admitted = [
      ["api segment", "src/auth/api.ts"],
      ["nested api route", "src/app/api/auth/cli/route.ts"],
      ["handlers dir", "src/handlers/carts.ts"],
      ["go api dir", "internal/api/router.go"],
      ["python api dir", "app/api/views.py"],
      ["services dir", "src/services/thing.ts"],
      ["rust handlers file", "crates/vibe_lsp/src/handlers.rs"],
      // `routers` is a real routing directory, not a substring accident.
      // trpc keeps its Prisma data access here, so excluding it would be a
      // recall regression rather than a false-positive fix.
      ["routers dir", "examples/next-prisma-starter/src/server/routers/post.ts"],
      ["router.go as a full segment", "internal/router.go"],
    ] as const;

    for (const [name, path] of admitted) {
      it(`admits ${name}`, () => {
        expect(classified(path)).toBe(true);
      });
    }

    it("still rejects an ordinary source file", () => {
      expect(classified("src/scoring/engine.ts")).toBe(false);
    });
  });

  describe("finding level: the reported symptom", () => {
    it("does not invent an ORM majority from `content.` substrings", () => {
      // Five files whose only data-access-looking line is a string split, plus one
      // real HTTP client. Before the fix this produced exactly:
      //   "Pattern drift: src/handlers/f5.ts uses http_client while 5/6 files use orm"
      const files: SourceFile[] = [];
      for (let i = 0; i < 5; i++) {
        files.push(file(`src/handlers/f${i}.ts`, 'const lines = file.content.split("\\n");'));
      }
      files.push(file("src/handlers/f5.ts", "await fetch(url);"));

      const findings = patternFindings(classifyPatterns(files));
      expect(findings.filter((f) => /\borm\b/.test(f.message))).toEqual([]);
    });

    it("still reports drift when a real ORM majority exists", () => {
      // Guards the opposite direction: the detector must not go silent.
      const files: SourceFile[] = [];
      for (let i = 0; i < 5; i++) {
        files.push(file(`src/handlers/f${i}.ts`, "const rows = await prisma.user.findMany({ where: { id } });"));
      }
      files.push(file("src/handlers/f5.ts", "await fetch(url);"));

      const findings = patternFindings(classifyPatterns(files));
      expect(findings.some((f) => /uses http_client while 5\/6 files use orm/.test(f.message))).toBe(true);
    });
  });
});
