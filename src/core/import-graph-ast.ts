/**
 * AST-based import/export extraction using tree-sitter.
 *
 * Walks the parsed syntax tree to extract import sources, imported names,
 * and exported symbols — replacing the regex-based parseImports/parseExports
 * for files that have a parsed tree available.
 *
 * Falls back gracefully: callers should check file.tree before calling these
 * and use the regex versions as fallback when no tree is available.
 */

import type { Tree, SyntaxNode } from "./types.js";
import type { FileExport, FileImports } from "./import-graph.js";

/**
 * Extract imports from a parsed AST tree.
 * Handles: static imports, re-exports, dynamic imports and require() (via recursive tree scan).
 */
export function parseImportsAst(tree: Tree): FileImports {
  const names = new Set<string>();
  const sources = new Set<string>();
  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;

    if (node.type === "import_statement") {
      extractStaticImport(node, names, sources);
    } else if (node.type === "export_statement") {
      // Re-exports: export { X } from "./y" / export * from "./y"
      extractReExportSource(node, sources);
    }
  }

  // Scan the ENTIRE tree for dynamic imports and require() calls nested inside
  // functions, if-blocks, etc. that the top-level pass misses.
  extractNestedImports(root, names, sources);

  return { names, sources };
}

/**
 * Extract exports from a parsed AST tree.
 */
export function parseExportsAst(tree: Tree, relativePath: string): FileExport[] {
  const exports: FileExport[] = [];
  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;
    if (node.type !== "export_statement") continue;

    const hasDefault = node.children.some((c) => c?.type === "default");
    const exportClause = findChild(node, "export_clause");
    const declaration = node.children.find((c) => c?.type.includes("declaration") || c?.type === "class");
    const source = findChild(node, "string");

    if (exportClause && !source) {
      // export { foo, bar } (local re-export without source)
      extractExportClauseNames(exportClause, relativePath, exports, false);
    } else if (exportClause && source) {
      // export { foo, bar } from "./y" — re-export with source
      // Names are exported from THIS file (the barrel)
      extractExportClauseNames(exportClause, relativePath, exports, false);
    } else if (declaration) {
      // export function hello() {} / export const X = ...
      const name = extractDeclarationName(declaration);
      if (name) {
        const line = node.startPosition.row + 1;
        exports.push({ name, file: relativePath, line, isDefault: hasDefault });
      }
    } else if (hasDefault) {
      // export default <expression> — try to extract identifier
      const ident = node.children.find((c) => c?.type === "identifier");
      if (ident) {
        const line = node.startPosition.row + 1;
        exports.push({ name: ident.text, file: relativePath, line, isDefault: true });
      }
    } else if (node.children.some((c) => c?.type === "*") || findChild(node, "namespace_export")) {
      // export * from "./y" — namespace re-export, no named exports from here
      // The namespace_export case: export * as stuff from "./y"
      const nsExport = findChild(node, "namespace_export");
      if (nsExport) {
        const ident = findChild(nsExport, "identifier");
        if (ident) {
          const line = node.startPosition.row + 1;
          exports.push({ name: ident.text, file: relativePath, line, isDefault: false });
        }
      }
    }
  }

  return exports;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractStaticImport(node: SyntaxNode, names: Set<string>, sources: Set<string>): void {
  // Extract source path
  const sourceNode = findChild(node, "string");
  if (!sourceNode) return;
  const source = extractStringValue(sourceNode);
  if (source) sources.add(source);

  // Extract imported names from the import clause
  const importClause = findChild(node, "import_clause");
  if (!importClause) return;

  for (let i = 0; i < importClause.childCount; i++) {
    const child = importClause.child(i)!;
    if (child.type === "named_imports") {
      // { foo, bar, baz as x }
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j)!;
        if (spec.type === "import_specifier") {
          // First identifier is the imported name
          const ident = findChild(spec, "identifier");
          if (ident) names.add(ident.text);
        }
      }
    } else if (child.type === "namespace_import") {
      // * as ns
      const ident = findChild(child, "identifier");
      if (ident) names.add(ident.text);
    } else if (child.type === "identifier") {
      // Default import: import Foo from "./x"
      names.add(child.text);
    }
  }
}

function extractReExportSource(node: SyntaxNode, sources: Set<string>): void {
  // Only re-exports have a source string: export { X } from "./y" or export * from "./y"
  const sourceNode = findChild(node, "string");
  if (sourceNode) {
    const source = extractStringValue(sourceNode);
    if (source) sources.add(source);
  }
}

function extractExportClauseNames(
  clause: SyntaxNode,
  relativePath: string,
  exports: FileExport[],
  isDefault: boolean,
): void {
  for (let i = 0; i < clause.childCount; i++) {
    const spec = clause.child(i)!;
    if (spec.type === "export_specifier") {
      // First identifier is the local name being exported
      const ident = findChild(spec, "identifier");
      if (ident) {
        const line = spec.startPosition.row + 1;
        exports.push({ name: ident.text, file: relativePath, line, isDefault });
      }
    }
  }
}

function extractDeclarationName(declaration: SyntaxNode): string | null {
  // function_declaration → identifier child
  // lexical_declaration → variable_declarator → identifier child
  // class_declaration → identifier child
  if (declaration.type === "function_declaration" || declaration.type === "class_declaration"
    || declaration.type === "class" || declaration.type === "abstract_class_declaration") {
    const ident = findChild(declaration, "identifier") ?? findChild(declaration, "type_identifier");
    return ident?.text ?? null;
  }
  if (declaration.type === "lexical_declaration") {
    const declarator = findChild(declaration, "variable_declarator");
    if (declarator) {
      const ident = declarator.child(0);
      if (ident?.type === "identifier") return ident.text;
    }
  }
  return null;
}

/** Extract the string value from a string node (strips quotes). */
function extractStringValue(node: SyntaxNode): string | null {
  const fragment = findChild(node, "string_fragment");
  return fragment?.text ?? null;
}

/** Find the first direct child with the given type. */
function findChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === type) return child;
  }
  return null;
}

/** Find the first descendant (DFS) with the given type. */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === type) return child;
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}


/**
 * Recursively scan the entire tree for dynamic import() and require() calls
 * nested inside functions, if-blocks, loops, etc.
 *
 * This catches patterns like:
 *   async function runScan() { const { X } = await import("./y"); }
 *   if (flag) { const mod = require("./z"); }
 */
function extractNestedImports(node: SyntaxNode, names: Set<string>, sources: Set<string>): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;

    if (child.type === "call_expression") {
      const callee = child.child(0);
      if (!callee) continue;

      // Dynamic import(): import("./source")
      if (callee.type === "import") {
        const args = findChild(child, "arguments");
        if (args) {
          const sourceNode = findChild(args, "string");
          if (sourceNode) {
            const source = extractStringValue(sourceNode);
            if (source) sources.add(source);
          }
        }
        // Try to extract names from parent variable_declarator
        extractNamesFromParentDeclarator(child, names);
        continue;
      }

      // require(): require("./source")
      if (callee.type === "identifier" && callee.text === "require") {
        const args = findChild(child, "arguments");
        if (args) {
          const sourceNode = findChild(args, "string");
          if (sourceNode) {
            const source = extractStringValue(sourceNode);
            if (source) sources.add(source);
          }
        }
        // Try to extract names from parent variable_declarator
        extractNamesFromParentDeclarator(child, names);
        continue;
      }
    }

    // Recurse into child nodes (but skip import_statement / export_statement
    // which are already handled at top-level, and skip string/number/comment
    // leaf nodes that can't contain imports)
    if (child.type !== "import_statement" && child.type !== "export_statement"
      && child.childCount > 0) {
      extractNestedImports(child, names, sources);
    }
  }
}

/**
 * Walk up from a call_expression to find its parent variable_declarator
 * and extract destructured or identifier names.
 */
function extractNamesFromParentDeclarator(callExpr: SyntaxNode, names: Set<string>): void {
  // The structure is: variable_declarator > [await_expression >] call_expression
  // We need to find the variable_declarator's name/pattern
  let current = callExpr.parent;
  // Walk up through await_expression if present
  if (current?.type === "await_expression") current = current.parent;
  if (!current || current.type !== "variable_declarator") return;

  const pattern = current.child(0);
  if (!pattern) return;

  if (pattern.type === "object_pattern") {
    for (let i = 0; i < pattern.childCount; i++) {
      const prop = pattern.child(i)!;
      if (prop.type === "shorthand_property_identifier_pattern") {
        names.add(prop.text);
      } else if (prop.type === "pair_pattern") {
        const key = prop.child(0);
        if (key?.type === "property_identifier") names.add(key.text);
      }
    }
  } else if (pattern.type === "identifier") {
    names.add(pattern.text);
  }
}
