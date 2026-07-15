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
 * SCOPE. This module ships both language halves of the index. The Python half
 * (Task 1) resolves a relative import to its defining file's body. The Go half
 * (Task 3) resolves a `pkg.Symbol` selector to a cross-PACKAGE
 * `function_declaration` body: a package import path maps to a repo directory via
 * the root go.mod module path, that directory's exported function_declaration
 * bodies are collected, and `resolveGoMiddlewareBody` returns the single exact
 * match (or null on any ambiguity). Nothing here is wired into the classifiers by
 * THIS module — with the index absent, the extractors behave exactly as today
 * (byte-identical); the wiring lives at each classifier's call site.
 */

import type { SyntaxNode } from "../core/types.js";
import type { DriftFile } from "./types.js";
import { collectFunctionDefs } from "./security-ast-python.js";
import { collectGoFunctionDefs } from "./security-ast-go.js";

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
    /** Root go.mod module path; falsy (undefined / null / "") disables Go
     *  cross-file wholesale — no go.mod, a `replace` directive, or a nested
     *  go.mod all collapse it upstream, leaving every Go map below empty. */
    modulePath?: string;
    /** Every Go file's relativePath (parse-broken files included, for parity
     *  with `py.files`). Not itself a resolution surface — resolution is
     *  package-directory based via `packages`. */
    files: Set<string>;
    /** pkgDir (a repo directory) -> its package. `defs` is
     *  `function_declaration`-ONLY (never `method_declaration`), merged across the
     *  package's NON-test .go files, sticky-null on a name defined twice. Each
     *  per-symbol entry carries its OWN defining file's both-kinds defs so the
     *  target body's in-file one-hop resolves against the right file. */
    packages: Map<string, GoPackage>;
    /** importer relativePath -> (qualifier -> pkgDir | null). The qualifier is
     *  the import alias when present, else the target package's DECLARED name
     *  (only USUALLY the import path's last segment). Two specs yielding one
     *  qualifier -> null (ambiguous). */
    fileImports: Map<string, Map<string, string | null>>;
    /** importer relativePath -> identifiers bound as a VALUE anywhere in the file
     *  (`:=`, `var`, `const`, params, method RECEIVERS, named RETURNS, func_literal
     *  params, range targets, type-switch guards). A qualifier in this set is a
     *  local value, not the package — refuse (the killer Go value-shadow vector). */
    valueBound: Map<string, Set<string>>;
    /** importer relativePaths that contain a `. "..."` dot-import; any selector in
     *  such a file is refused (unqualified injection is ambiguous with in-file
     *  identifiers). */
    dotImports: Set<string>;
  };
}

/** One cross-package `function_declaration` entry: the def node, its defining
 *  file's relativePath, and that file's OWN both-kinds defs (for the resolved
 *  body's single in-file hop — never a pkgDir-arbitrary sibling's). */
export interface GoPackageEntry {
  def: SyntaxNode;
  file: string;
  fileDefs: Map<string, SyntaxNode | null>;
}

/** One Go package (= one directory). `pkgName` is the DECLARED `package` clause
 *  name, or null when two non-test files in the dir disagree (a broken package,
 *  refused wholesale). `defs` is function_declaration-only, sticky-null on a name
 *  defined twice across the package's non-test files. */
export interface GoPackage {
  pkgName: string | null;
  defs: Map<string, GoPackageEntry | null>;
}

/** A resolved cross-package middleware: the def node and its OWN defining-file
 *  both-kinds defs (for the target body's in-file one-hop). */
export interface GoResolvedMiddleware {
  def: SyntaxNode;
  defs: Map<string, SyntaxNode | null>;
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
export function buildXFileIndex(files: DriftFile[], goModulePath?: string | null): CrossFileIndex {
  const index: CrossFileIndex = {
    py: { files: new Set(), fileDefs: new Map(), roots: new Map() },
    go: {
      // Normalize every falsy module path (null / "" / undefined) to undefined:
      // the single "Go disabled" signal `resolveGoMiddlewareBody` gates on.
      modulePath: goModulePath || undefined,
      files: new Set(),
      packages: new Map(),
      fileImports: new Map(),
      valueBound: new Map(),
      dotImports: new Set(),
    },
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

  buildGoHalf(index, sorted, index.go.modulePath);
  return index;
}

// ─── Go index construction ───────────────────────────────────────────────────

/** Fill the Go half of the index. `go.files` holds every Go file's relativePath
 *  (parse-broken included). The resolution maps (packages / fileImports /
 *  valueBound / dotImports) are built ONLY when a single-root module path is
 *  supplied; otherwise Go cross-file stays disabled (all maps empty). */
function buildGoHalf(index: CrossFileIndex, sorted: DriftFile[], goModulePath: string | undefined): void {
  for (const f of sorted) {
    if (f.language === "go") index.go.files.add(f.relativePath);
  }
  if (!goModulePath) return; // no go.mod / replace / nested module => Go disabled

  // Non-test, clean-tree Go files only: a `*_test.go` co-locates a `package
  // foo_test` clause (nulls pkgName) and in-test helpers (duplicate-null real
  // defs), and a broken tree can never contribute a bless.
  const goFiles = sorted.filter(
    (f) => f.language === "go" && f.tree && !f.tree.rootNode.hasError && !isGoTestFile(f.relativePath),
  );

  // Build every package (= one directory) FIRST, so a plain import can key its
  // qualifier by the target dir's declared package name.
  const byDir = new Map<string, DriftFile[]>();
  for (const f of goFiles) {
    const dir = goDir(f.relativePath);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(f);
    else byDir.set(dir, [f]);
  }
  for (const [dir, filesInDir] of byDir) {
    index.go.packages.set(dir, buildGoPackage(filesInDir));
  }

  for (const f of goFiles) {
    const root = f.tree!.rootNode;
    const { imports, hasDot } = buildGoFileImports(root, goModulePath, index.go.packages);
    index.go.fileImports.set(f.relativePath, imports);
    if (hasDot) index.go.dotImports.add(f.relativePath);
    index.go.valueBound.set(f.relativePath, collectGoValueBound(root));
  }
}

/** True for a Go external-test / test file, excluded wholesale from the package
 *  index (a co-located `package foo_test` clause or an in-test helper must never
 *  perturb `pkgName` or duplicate-null a real def). */
function isGoTestFile(rel: string): boolean {
  return /_test\.go$/.test(rel);
}

/** Directory of a repo-relative path ("" for a root-level file). */
function goDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** Declared `package` name of a Go file (package_clause has NO name field; the
 *  declared name is `namedChild(0)`), or null. */
function goPackageName(root: SyntaxNode): string | null {
  for (const child of root.namedChildren) {
    if (child?.type === "package_clause") {
      const id = child.namedChild(0);
      return id?.type === "package_identifier" ? id.text : null;
    }
  }
  return null;
}

/** Build one package from its non-test clean files: the agreed `pkgName` (null on
 *  disagreement) and a function_declaration-only def map, sticky-null on any name
 *  defined twice across the package's files. Each surviving entry carries its OWN
 *  defining file's both-kinds defs. */
function buildGoPackage(filesInDir: DriftFile[]): GoPackage {
  let pkgName: string | null | undefined = undefined;
  for (const f of filesInDir) {
    const name = goPackageName(f.tree!.rootNode);
    if (pkgName === undefined) pkgName = name;
    else if (pkgName !== name) pkgName = null; // two non-test files disagree => refuse the pkg
  }

  const defs = new Map<string, GoPackageEntry | null>();
  for (const f of filesInDir) {
    const root = f.tree!.rootNode;
    let fileDefs: Map<string, SyntaxNode | null> | null = null;
    for (const decl of root.descendantsOfType("function_declaration")) {
      if (!decl || decl.hasError) continue; // a parse-errored def never contributes
      const name = decl.childForFieldName("name")?.text;
      if (!name) continue;
      if (defs.has(name)) {
        defs.set(name, null); // sticky-null: a second definition (this file or a sibling)
        continue;
      }
      if (fileDefs === null) fileDefs = collectGoFunctionDefs(root); // both kinds, for the in-file hop
      defs.set(name, { def: decl, file: f.relativePath, fileDefs });
    }
  }
  return { pkgName: pkgName ?? null, defs };
}

/** The importer's import surface: qualifier -> pkgDir (or null on ambiguity), and
 *  whether the file carries any dot-import. A plain import keys by the target
 *  dir's DECLARED package name; an alias is authoritative; a `dot` sets the poison
 *  flag; a `blank_identifier` (side-effect import) is ignored. Two specs yielding
 *  one qualifier collapse to null. */
function buildGoFileImports(
  root: SyntaxNode,
  modulePath: string,
  packages: Map<string, GoPackage>,
): { imports: Map<string, string | null>; hasDot: boolean } {
  const imports = new Map<string, string | null>();
  const seen = new Set<string>();
  let hasDot = false;
  const add = (qualifier: string, dir: string | null) => {
    if (seen.has(qualifier)) {
      imports.set(qualifier, null); // two specs -> one qualifier -> ambiguous
      return;
    }
    seen.add(qualifier);
    imports.set(qualifier, dir);
  };

  for (const spec of root.descendantsOfType("import_spec")) {
    if (!spec) continue;
    const importPath = goStringLiteralText(spec.childForFieldName("path"));
    if (importPath === null) continue;
    const dir = goImportPathToDir(importPath, modulePath); // null => external
    const nameNode = spec.childForFieldName("name");
    if (nameNode) {
      if (nameNode.type === "dot") {
        hasDot = true;
        continue;
      }
      if (nameNode.type === "blank_identifier") continue; // side-effect only
      if (nameNode.type === "package_identifier") {
        add(nameNode.text, dir); // alias is the authoritative qualifier
      }
      continue;
    }
    // Plain import: the qualifier is the target dir's DECLARED package name.
    if (dir === null) continue; // external, unresolvable
    const pkgName = packages.get(dir)?.pkgName ?? null;
    if (pkgName === null) continue; // no known/agreeing package => no usable qualifier
    add(pkgName, dir);
  }
  return { imports, hasDot };
}

/** Strip the delimiters of a Go string literal node (both kinds include them). */
function goStringLiteralText(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal") return null;
  return node.text.slice(1, -1);
}

/** Repo dir for an import path under `modulePath`, or null (external). Correct
 *  only for a single root module with no path remapping — the plumbing forces
 *  `modulePath` off on a `replace` or a nested go.mod. */
function goImportPathToDir(importPath: string, modulePath: string): string | null {
  if (importPath === modulePath) return "";
  if (importPath.startsWith(modulePath + "/")) return importPath.slice(modulePath.length + 1);
  return null;
}

/** Identifiers bound as a VALUE anywhere in the file. Over-collection is safe (it
 *  only ADDS refusals): a qualifier that is also a local value must never be
 *  attributed to a package function. Covers `:=`, `var`, `const`, all params
 *  (including method receivers and named returns, which are `parameter_declaration`
 *  nodes in the `receiver`/`result` fields), range targets, and type-switch guards. */
function collectGoValueBound(root: SyntaxNode): Set<string> {
  const bound = new Set<string>();
  const addId = (n: SyntaxNode | null) => {
    if (n && n.type === "identifier") bound.add(n.text);
  };
  const addList = (n: SyntaxNode | null) => {
    if (!n) return;
    if (n.type === "expression_list") for (const c of n.namedChildren) addId(c);
    else addId(n);
  };
  for (const d of root.descendantsOfType("short_var_declaration")) if (d) addList(d.childForFieldName("left"));
  for (const d of root.descendantsOfType("range_clause")) if (d) addList(d.childForFieldName("left"));
  for (const d of root.descendantsOfType("type_switch_statement")) if (d) addList(d.childForFieldName("alias"));
  for (const t of ["var_spec", "const_spec", "parameter_declaration"] as const) {
    for (const d of root.descendantsOfType(t)) {
      if (!d) continue;
      for (const nm of d.childrenForFieldName("name")) addId(nm);
    }
  }
  return bound;
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

// ─── Go resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a Go `qualifier.Symbol` selector to its cross-PACKAGE
 * `function_declaration` body, or null (refuse). `selectorText` is a PURE
 * selector's text (the caller guarantees purity via `goMiddlewareName`), so the
 * structural split is a single-dot split. Every refuse path (see the module
 * invariant + the Go refuse table) returns null:
 *   - Go disabled (no/replaced/nested go.mod => falsy modulePath);
 *   - not a simple `pkg.Symbol` (no dot, or a deeper field chain);
 *   - the importer carries a dot-import (blanket refuse);
 *   - the qualifier is bound as a LOCAL VALUE in the importer (the value-shadow
 *     vector: a receiver/param/`:=`/var/const named like the package);
 *   - the qualifier is not an import of the importer, or maps to null (ambiguous);
 *   - the target package is unknown, or its files disagree on `pkgName`;
 *   - the symbol is unexported (lowercase — a real cross-package ref is Capitalized);
 *   - the symbol is undefined in the package, or defined twice (sticky-null),
 *     or is a `method_declaration` (never in the function_declaration-only defs).
 * On success returns the def plus the def's OWN defining-file both-kinds defs.
 */
export function resolveGoMiddlewareBody(
  importerRel: string,
  selectorText: string,
  index: CrossFileIndex,
): GoResolvedMiddleware | null {
  if (!index.go.modulePath) return null; // Go cross-file disabled wholesale

  // Structural split of a pure `qualifier.symbol`: exactly one dot.
  const dot = selectorText.indexOf(".");
  if (dot <= 0) return null; // no qualifier, or a leading dot
  const qualifier = selectorText.slice(0, dot);
  const symbol = selectorText.slice(dot + 1);
  if (symbol.length === 0 || symbol.includes(".")) return null; // deeper chain, not pkg.Symbol

  if (index.go.dotImports.has(importerRel)) return null; // dot-import blanket refuse
  if (index.go.valueBound.get(importerRel)?.has(qualifier)) return null; // local value shadows the package

  const dir = index.go.fileImports.get(importerRel)?.get(qualifier);
  if (dir === undefined || dir === null) return null; // not imported here, or ambiguous qualifier

  const pkg = index.go.packages.get(dir);
  if (!pkg || pkg.pkgName === null) return null; // no package, or files disagree on pkgName

  // EXPORTED-only (conservative v1): a cross-package reference is always Capitalized.
  const first = symbol[0];
  if (first < "A" || first > "Z") return null;

  const entry = pkg.defs.get(symbol);
  if (!entry) return null; // undefined (not defined) or null (duplicate across the package's files)
  return { def: entry.def, defs: entry.fileDefs };
}
