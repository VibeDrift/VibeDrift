/**
 * Repo-wide cross-file symbol index for the security auth detectors.
 *
 * The shipped Python/Go auth extractors read a middleware/hook body IN-FILE
 * only, so a hook whose implementation is imported from another module resolves
 * to UNSURE (never a bless). This index is the spine that lets a LATER task
 * resolve an imported hook symbol to its in-repo defining file's body — but
 * ONLY when the resolution is exact and unambiguous.
 *
 * GOVERNING INVARIANT — NEVER-FALSE-BLESS. A WRONG cross-file attribution (a
 * route blessed from the wrong body) is the worst outcome. Every ambiguity in
 * this module resolves to `null` (refuse), never a guess:
 *   - resolution is PATH-ANCHORED (a relative import is resolved lexically to a
 *     single candidate file), never NAME-SEARCHED across the repo — a sibling
 *     file that happens to define the same symbol is NEVER consulted;
 *   - two candidate files (`mod.py` AND `mod/__init__.py`) => refuse;
 *   - a symbol defined twice in the target => refuse (collectFunctionDefs
 *     poisons it to null);
 *   - an absolute import, a beyond-root relative import, a wildcard import
 *     anywhere in the importer, a name bound by more than one import, a name
 *     shadowed by a same-file def/class/assignment, a target with a parse
 *     error, and a re-export chain deeper than one hop => all refuse.
 *
 * DETERMINISM. The build is order-independent: it sorts by relativePath and
 * keys everything by path, so the same repo yields the same index regardless of
 * the caller's file ordering. It never re-parses — it reuses each DriftFile's
 * pre-parsed tree — so a symbol maps to the SAME node reference across builds.
 *
 * SCOPE (Task 1). This task ships the Python half + the index skeleton. The Go
 * half of the index is stubbed (empty maps, module path stored) and
 * `resolveGoMiddlewareBody` returns null; both are populated in a later task.
 * Nothing here is wired into the classifiers yet — with the index absent, the
 * extractors behave exactly as today (byte-identical).
 */

import type { SyntaxNode } from "../core/types.js";
import type { DriftFile } from "./types.js";
import { collectFunctionDefs } from "./security-ast-python.js";

/** Per-language cross-file lookup tables. */
export interface CrossFileIndex {
  py: {
    /** Every python file's relativePath — BROKEN (parse-error) files included,
     *  so candidate-file existence checks see the whole repo surface. */
    files: Set<string>;
    /** `collectFunctionDefs` per NON-broken python file, keyed by relativePath.
     *  A broken file has no entry (the `fileDefs.has` gate then refuses it). */
    fileDefs: Map<string, Map<string, SyntaxNode | null>>;
    /** Root node per NON-broken python file, keyed by relativePath. Used to
     *  reconstruct import tables (the importer's, and a re-export __init__'s).
     *  Same keyset as `fileDefs`. */
    roots: Map<string, SyntaxNode>;
  };
  go: {
    /** Root go.mod module path; undefined disables Go cross-file wholesale. */
    modulePath?: string;
    /** Stub in Task 1 — populated with per-package data in a later task. */
    files: Set<string>;
    /** Stub in Task 1 — per-package function_declaration maps (NOT
     *  method_declaration) come in a later task. */
    packageFuncs: Map<string, Map<string, SyntaxNode | null>>;
  };
}

/** A resolved cross-file hook: the DEFINING file's body node, that file's
 *  full def map (for same-file helper hops inside `bodyAuthSignature`), and the
 *  true (pre-alias, post-re-export) symbol name. */
export interface PyResolvedHook {
  body: SyntaxNode | null;
  defs: Map<string, SyntaxNode | null>;
  originalName: string;
}

/**
 * Build the repo-wide index ONCE over all DriftFiles. Order-independent:
 * sorts by relativePath and keys by path. `goModulePath` is stored on the Go
 * half (undefined disables Go cross-file); the Go maps are stubbed empty in
 * Task 1.
 */
export function buildXFileIndex(files: DriftFile[], goModulePath?: string): CrossFileIndex {
  const index: CrossFileIndex = {
    py: { files: new Set(), fileDefs: new Map(), roots: new Map() },
    go: { modulePath: goModulePath, files: new Set(), packageFuncs: new Map() },
  };

  // Deterministic iteration: a stable code-unit sort of relativePath so the
  // built maps (and their iteration order) are identical for any input order.
  const sorted = [...files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  for (const f of sorted) {
    if (f.language !== "python" || !f.tree) continue;
    const rel = f.relativePath;
    // Conservative duplicate-path handling: a relativePath seen twice is a repo
    // anomaly — poison it (drop its defs/root so it can never be a resolution
    // target), but keep it in `files`. Refuse beats last-wins.
    if (index.py.files.has(rel) && (index.py.fileDefs.has(rel) || index.py.roots.has(rel))) {
      index.py.fileDefs.delete(rel);
      index.py.roots.delete(rel);
      continue;
    }
    index.py.files.add(rel);
    const root = f.tree.rootNode;
    if (!root.hasError) {
      index.py.roots.set(rel, root);
      index.py.fileDefs.set(rel, collectFunctionDefs(root));
    }
  }

  return index;
}

// ─── Python resolution ───────────────────────────────────────────────────────

/** A single relative-import binding: the dot count, the module subpath after
 *  the dots, and the imported symbol's ORIGINAL (pre-alias) name. */
interface RelativeBinding {
  dots: number;
  subpathSegments: string[];
  originalName: string;
}

/** The reconstructed import surface of one python file. */
interface PyImportTable {
  /** Any `wildcard_import` anywhere in the file blanket-refuses resolution. */
  wildcard: boolean;
  /** How many imports (of ANY kind) bind each local name — >1 poisons it. */
  bindCount: Map<string, number>;
  /** Local name -> its relative-import target (only for relative from-imports
   *  with a real module subpath). */
  relativeTarget: Map<string, RelativeBinding>;
  /** Local names also bound by a same-file def/class/module-scope assignment;
   *  such a name is shadowed, so the import must not be resolved for it. */
  moduleScopeShadows: Set<string>;
}

/**
 * Resolve an imported hook symbol to the body of its in-repo defining file.
 * Returns null for every refuse path (see the module invariant). `importerRel`
 * must be a NON-broken python file known to the index.
 */
export function resolvePyHookBody(
  index: CrossFileIndex,
  importerRel: string,
  localName: string,
): PyResolvedHook | null {
  const importerRoot = index.py.roots.get(importerRel);
  if (!importerRoot) return null; // importer absent or broken tree

  const table = buildPyImportTable(importerRoot);
  if (table.wildcard) return null; // blanket refuse: a wildcard could bind localName

  const resolved = resolveBinding(index, importerRel, table, localName);
  if (!resolved) return null;

  return lookupOrReexport(index, resolved.targetRel, resolved.originalName);
}

/** Resolve a local name through the importer's import table to a single
 *  candidate target file, or null (poisoned / shadowed / absolute / no-target /
 *  beyond-root / ambiguous / not-found). */
function resolveBinding(
  index: CrossFileIndex,
  importerRel: string,
  table: PyImportTable,
  localName: string,
): { targetRel: string; originalName: string } | null {
  if (table.moduleScopeShadows.has(localName)) return null; // local shadow wins at runtime
  if (table.bindCount.get(localName) !== 1) return null; // unbound (0) or poisoned (>1)
  const binding = table.relativeTarget.get(localName);
  if (!binding) return null; // bound, but by a non-relative import (absolute / plain)
  const targetRel = resolveRelativePath(
    importerRel,
    binding.dots,
    binding.subpathSegments,
    index.py.files,
  );
  if (!targetRel) return null;
  return { targetRel, originalName: binding.originalName };
}

/** Look up `originalName` in the target file's defs; on a miss, try ONE relative
 *  re-export hop from that file's own imports. Every branch refuses on ambiguity. */
function lookupOrReexport(
  index: CrossFileIndex,
  targetRel: string,
  originalName: string,
): PyResolvedHook | null {
  const defs = index.py.fileDefs.get(targetRel);
  if (!defs) return null; // target has no defs entry => parse error => refuse
  const def = defs.get(originalName);
  if (def === null) return null; // duplicate def in target => refuse
  if (def !== undefined) {
    if (!isTopLevelDef(def, index.py.roots.get(targetRel)!)) return null; // nested/method: not importable
    return { body: def.childForFieldName("body"), defs, originalName };
  }
  return reexportHop(index, targetRel, originalName);
}

/** ONE relative re-export hop: reconstruct the target file's import table,
 *  resolve `originalName`'s OWN relative import to a second file, and look the
 *  re-export's pre-alias original name up there. Never hops again (cap 1), so a
 *  chain deeper than one hop refuses. */
function reexportHop(
  index: CrossFileIndex,
  targetRel: string,
  originalName: string,
): PyResolvedHook | null {
  const targetRoot = index.py.roots.get(targetRel);
  if (!targetRoot) return null;
  const table = buildPyImportTable(targetRoot);
  if (table.wildcard) return null;
  const resolved = resolveBinding(index, targetRel, table, originalName);
  if (!resolved) return null;

  const defs = index.py.fileDefs.get(resolved.targetRel);
  if (!defs) return null; // second target parse error => refuse
  const def = defs.get(resolved.originalName);
  // undefined here == the re-export points at yet ANOTHER re-export: depth
  // exceeded (cap 1) => refuse. null == duplicate def => refuse.
  if (def === null || def === undefined) return null;
  if (!isTopLevelDef(def, index.py.roots.get(resolved.targetRel)!)) return null;
  return { body: def.childForFieldName("body"), defs, originalName: resolved.originalName };
}

/**
 * Lexically resolve a relative import to a single in-repo file, or null.
 * `dots` counts the leading dots (1 = current package, N = up N-1 levels);
 * `subpathSegments` is the module path after the dots. Refuses when the dots
 * reach beyond the repo root, when both `<path>.py` and `<path>/__init__.py`
 * exist (ambiguous), or when neither exists.
 */
function resolveRelativePath(
  importerRel: string,
  dots: number,
  subpathSegments: string[],
  files: Set<string>,
): string | null {
  if (subpathSegments.length === 0) return null; // bare `from . import X`: submodule, not a module symbol
  const dirSegments = dirnameSegments(importerRel);
  const upLevels = dots - 1;
  if (upLevels > dirSegments.length) return null; // beyond repo root
  const base = dirSegments.slice(0, dirSegments.length - upLevels);
  const moduleSegments = [...base, ...subpathSegments];
  const modulePath = moduleSegments.join("/");
  const asModule = `${modulePath}.py`;
  const asPackage = `${modulePath}/__init__.py`;
  const hasModule = files.has(asModule);
  const hasPackage = files.has(asPackage);
  if (hasModule && hasPackage) return null; // ambiguous: two candidate files
  if (hasModule) return asModule;
  if (hasPackage) return asPackage;
  return null; // not found
}

/** Path segments of the directory containing `rel` (empty for a root file). */
function dirnameSegments(rel: string): string[] {
  const parts = rel.split("/");
  parts.pop(); // drop the filename
  return parts.filter((p) => p.length > 0);
}

/**
 * Reconstruct a python file's import surface from its TOP-LEVEL import
 * statements. Absolute from-imports and plain `import` statements RECORD the
 * name they bind (so they can poison a co-imported relative name) but never
 * become resolvable targets. A wildcard anywhere in the file sets `wildcard`.
 */
function buildPyImportTable(root: SyntaxNode): PyImportTable {
  const wildcard = root
    .descendantsOfType("wildcard_import")
    .some((n): n is SyntaxNode => n !== null);
  const bindCount = new Map<string, number>();
  const relativeTarget = new Map<string, RelativeBinding>();
  const bump = (name: string) => bindCount.set(name, (bindCount.get(name) ?? 0) + 1);

  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "import_from_statement") {
      const moduleName = stmt.childForFieldName("module_name");
      const relative =
        moduleName?.type === "relative_import" ? relativeDotsAndSubpath(moduleName) : null;
      for (const nameNode of stmt.childrenForFieldName("name")) {
        if (!nameNode) continue;
        const bound = fromImportName(nameNode);
        if (!bound) continue;
        bump(bound.localName);
        // A relative from-import with a real module subpath is the only
        // resolvable form; absolute (dotted_name module) records the bind only.
        if (relative && relative.subpath.length > 0) {
          relativeTarget.set(bound.localName, {
            dots: relative.dots,
            subpathSegments: relative.subpath,
            originalName: bound.originalName,
          });
        }
      }
    } else if (stmt.type === "import_statement") {
      for (const nameNode of stmt.childrenForFieldName("name")) {
        if (!nameNode) continue;
        const local = plainImportName(nameNode);
        if (local) bump(local); // plain imports are absolute: bind only, never a target
      }
    }
  }

  return { wildcard, bindCount, relativeTarget, moduleScopeShadows: moduleScopeShadows(root) };
}

/** Dots and module subpath of a `relative_import` module_name node. */
function relativeDotsAndSubpath(moduleName: SyntaxNode): { dots: number; subpath: string[] } {
  let dots = 0;
  const subpath: string[] = [];
  for (const child of moduleName.namedChildren) {
    if (!child) continue;
    if (child.type === "import_prefix") {
      dots = child.text.length; // "." | ".." | "..."
    } else if (child.type === "dotted_name") {
      for (const id of child.namedChildren) {
        if (id && id.type === "identifier") subpath.push(id.text);
      }
    }
  }
  return { dots, subpath };
}

/** Local + original name bound by one `name`-field entry of a from-import. */
function fromImportName(nameNode: SyntaxNode): { localName: string; originalName: string } | null {
  if (nameNode.type === "aliased_import") {
    const originalName = nameNode.childForFieldName("name")?.text ?? "";
    const localName = nameNode.childForFieldName("alias")?.text ?? "";
    return localName && originalName ? { localName, originalName } : null;
  }
  if (nameNode.type === "dotted_name") {
    return { localName: nameNode.text, originalName: nameNode.text };
  }
  return null;
}

/** Local name bound by one `name`-field entry of a plain `import` statement
 *  (`import a.b` binds `a`; `import a.b as c` binds `c`). */
function plainImportName(nameNode: SyntaxNode): string | null {
  if (nameNode.type === "aliased_import") {
    return nameNode.childForFieldName("alias")?.text ?? null;
  }
  if (nameNode.type === "dotted_name") {
    return nameNode.namedChild(0)?.text ?? null; // top-level package binding
  }
  return null;
}

/** Names bound at module scope by a def/class/assignment — an import for such a
 *  name is shadowed at runtime and must not be resolved cross-file. */
function moduleScopeShadows(root: SyntaxNode): Set<string> {
  const shadows = new Set<string>();
  const addDefName = (node: SyntaxNode | null) => {
    const n = node?.childForFieldName("name")?.text;
    if (n) shadows.add(n);
  };
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "function_definition" || stmt.type === "class_definition") {
      addDefName(stmt);
    } else if (stmt.type === "decorated_definition") {
      addDefName(stmt.childForFieldName("definition"));
    } else if (stmt.type === "expression_statement") {
      for (const asn of stmt.namedChildren) {
        if (asn && asn.type === "assignment") {
          const left = asn.childForFieldName("left");
          if (left) for (const id of identifiersOf(left)) shadows.add(id);
        }
      }
    }
  }
  return shadows;
}

/** Identifier texts of an assignment LHS (a bare name, or every name in a
 *  tuple/list unpack target). */
function identifiersOf(node: SyntaxNode): string[] {
  if (node.type === "identifier") return [node.text];
  return node
    .descendantsOfType("identifier")
    .filter((n): n is SyntaxNode => n !== null)
    .map((n) => n.text);
}

/** True when a def is a module-level (importable) binding — its ancestor chain
 *  up to the module root passes through no function/class/lambda body. A class
 *  method or a nested function is NOT importable by a bare name, so resolving to
 *  it would be a wrong-body false-bless. */
function isTopLevelDef(def: SyntaxNode, root: SyntaxNode): boolean {
  let p = def.parent;
  while (p !== null && p.id !== root.id) {
    if (
      p.type === "function_definition" ||
      p.type === "class_definition" ||
      p.type === "lambda"
    ) {
      return false;
    }
    p = p.parent;
  }
  return true;
}

// ─── Go resolution (stub — populated in a later task) ────────────────────────

/**
 * Stub for Go cross-file middleware body resolution. Task 1 ships only the
 * index skeleton (module path stored, maps empty); Go resolution arrives in a
 * later task. Returns null so the Go extractor's behavior is unchanged today.
 */
export function resolveGoMiddlewareBody(): null {
  return null;
}
