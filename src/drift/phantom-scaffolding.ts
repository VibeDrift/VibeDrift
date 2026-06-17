/**
 * Phantom-scaffolding detector — uses the shared import graph (L1.5-A2).
 *
 * "Phantom scaffolding" is exported handler / CRUD code that no part of
 * the project actually uses: not imported anywhere, not registered in any
 * route table. AI sessions love generating "complete" CRUD handlers that
 * never get wired up.
 *
 * Old approach: a name-only usage graph (`/\b[A-Z]\w+\b/g`) which
 * false-positived on common type names like `User`, `Config`, `Handler`
 * appearing in unrelated files.
 *
 * New approach (this file):
 *   1. Build the bipartite import graph from src/core/import-graph.ts.
 *   2. Extract route registrations (Express, Echo, Gorilla, Flask).
 *   3. An export is phantom iff:
 *        - the file has zero incoming imports (graph.incomingCount === 0),
 *        - AND no route registration mentions this handler name,
 *        - AND the export name suggests CRUD intent (handler-like).
 *   4. Aggregate per directory: a directory with ≥2 phantoms is louder
 *      than scattered single-file phantoms.
 *
 * Limitations:
 *   - Import graph is JS/TS only (Go/Python/Rust phantoms not analyzed
 *     here — dead-code.ts handles those via its own substring approach).
 *   - Route detection is regex-based and framework-specific (Express,
 *     Echo, Gorilla, Flask). Custom routers may be missed.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, DeviatingFile, Evidence } from "./types.js";
import { buildImportGraph } from "../core/import-graph.js";
import type { SourceFile } from "../core/types.js";
import { directoryOf } from "./utils.js";

interface RouteRegistration {
  method: string;
  path: string;
  handlerName: string;
  file: string;
  line: number;
}

function isCrudLike(name: string): boolean {
  return /^(?:create|add|insert|new|register|store|save|get|find|fetch|read|load|retrieve|show|list|search|browse|index|update|edit|modify|patch|change|set|delete|remove|destroy|revoke|drop|unregister|purge)/i.test(name);
}

function extractRouteRegistrations(file: DriftFile): RouteRegistration[] {
  const routes: RouteRegistration[] = [];
  if (!file.language) return routes;
  const lines = file.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Go Echo: .GET("/path", handler) or .POST("/path", handler.Method)
    const echoMatch = line.match(/\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"\s*,\s*(\w+(?:\.\w+)?)/);
    if (echoMatch) {
      routes.push({ method: echoMatch[1], path: echoMatch[2], handlerName: echoMatch[3].split(".").pop()!, file: file.path, line: i + 1 });
      continue;
    }

    // Go Gorilla: HandleFunc("/path", handler)
    const gorillaMatch = line.match(/HandleFunc\s*\(\s*"([^"]+)"\s*,\s*(\w+(?:\.\w+)?)\)/);
    if (gorillaMatch) {
      const methodMatch = lines.slice(i, i + 2).join("").match(/Methods\s*\(\s*"(\w+)"/);
      routes.push({ method: methodMatch?.[1] ?? "ANY", path: gorillaMatch[1], handlerName: gorillaMatch[2].split(".").pop()!, file: file.path, line: i + 1 });
      continue;
    }

    // JS/TS Express: app.get('/path', handler)
    const expressMatch = line.match(/\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*(\w+))?/);
    if (expressMatch && expressMatch[3]) {
      routes.push({ method: expressMatch[1].toUpperCase(), path: expressMatch[2], handlerName: expressMatch[3], file: file.path, line: i + 1 });
      continue;
    }

    // Python Flask/FastAPI: @app.get('/path') with following def
    const pyMatch = line.match(/@\w+\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/);
    if (pyMatch) {
      const nextDef = lines.slice(i + 1, i + 5).find((l) => /^(?:async\s+)?def\s+(\w+)/.test(l.trim()));
      const handlerName = nextDef?.match(/def\s+(\w+)/)?.[1] ?? "";
      if (handlerName) {
        routes.push({ method: pyMatch[1].toUpperCase(), path: pyMatch[2], handlerName, file: file.path, line: i + 1 });
      }
    }
  }

  return routes;
}

export const phantomScaffolding: DriftDetector = {
  id: "phantom-scaffolding",
  name: "Phantom Scaffolding",
  category: "phantom_scaffolding",

  detect(ctx: DriftContext): DriftFinding[] {
    // Build the import graph for JS/TS files (the only language the graph covers today)
    const jsFiles: SourceFile[] = ctx.files
      .filter((f) => f.language === "javascript" || f.language === "typescript")
      .map((f) => ({
        path: f.path,
        relativePath: f.path,
        language: f.language as "javascript" | "typescript",
        content: f.content,
        lineCount: f.lineCount,
      }));
    if (jsFiles.length < 2) return [];

    const graph = buildImportGraph(jsFiles);

    // Routes across all files (any language)
    const allRoutes: RouteRegistration[] = [];
    for (const file of ctx.files) {
      allRoutes.push(...extractRouteRegistrations(file));
    }
    const routedHandlers = new Set(allRoutes.map((r) => r.handlerName));

    // Find phantom exports: CRUD-like name + zero incoming imports + not routed
    interface Phantom { file: string; line: number; name: string; }
    const phantoms: Phantom[] = [];
    for (const exports of graph.exportsByFile.values()) {
      for (const ex of exports) {
        if (!isCrudLike(ex.name)) continue;
        if (routedHandlers.has(ex.name)) continue;

        const incoming = graph.incomingCount.get(ex.file) ?? 0;
        // If the file has no incoming imports AND this export isn't routed,
        // the function is genuinely phantom — nobody calls it, no route
        // exposes it.
        if (incoming === 0) {
          phantoms.push({ file: ex.file, line: ex.line, name: ex.name });
        }
      }
    }

    if (phantoms.length === 0) return [];

    // Per-directory rollup
    const byDir = new Map<string, Phantom[]>();
    for (const p of phantoms) {
      const dir = directoryOf(p.file);
      const list = byDir.get(dir);
      if (list) list.push(p);
      else byDir.set(dir, [p]);
    }

    const findings: DriftFinding[] = [];
    const dirs = [...byDir.keys()].sort();
    for (const dir of dirs) {
      const dirPhantoms = byDir.get(dir)!;
      if (dirPhantoms.length === 0) continue;

      const byFile = new Map<string, Phantom[]>();
      for (const p of dirPhantoms) {
        const list = byFile.get(p.file);
        if (list) list.push(p);
        else byFile.set(p.file, [p]);
      }
      const deviating: DeviatingFile[] = [];
      for (const [file, ps] of byFile) {
        const evidence: Evidence[] = ps.slice(0, 3).map((p) => ({
          line: p.line,
          code: `export ${p.name}() — no incoming imports, not in any route table`,
        }));
        deviating.push({
          path: file,
          detectedPattern: `${ps.length} phantom export(s)`,
          evidence,
        });
      }

      findings.push({
        detector: "phantom-scaffolding",
        subCategory: "unrouted_handler",
        driftCategory: "phantom_scaffolding",
        severity: dirPhantoms.length >= 5 ? "error" : "warning",
        confidence: 0.8,
        finding: `${dir}/: ${dirPhantoms.length} phantom export(s) — CRUD-named functions never imported and never routed`,
        dominantPattern: "wired-up exports",
        dominantCount: 0,
        totalRelevantFiles: byFile.size,
        consistencyScore: Math.max(0, 100 - dirPhantoms.length * 10),
        deviatingFiles: deviating.slice(0, 10),
        // Phantom-scaffolding's "dominant" pattern is "wired-up exports" —
        // an abstract concept, not a set of specific files. No meaningful
        // reference files to list; leave empty.
        dominantFiles: [],
        recommendation: `Either wire these handlers into a route, import them where needed, or delete them.`,
      });
    }

    return findings;
  },
};
