import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import type { SupportedLanguage, SourceFile } from "../core/types.js";

const require = createRequire(import.meta.url);

let initialized = false;
const languageCache = new Map<string, Language>();

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

async function getLanguage(lang: SupportedLanguage, filePath?: string): Promise<Language> {
  const grammarMap: Record<SupportedLanguage, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    go: "go",
    rust: "rust",
  };

  // Use the tsx grammar for .tsx files (the typescript grammar doesn't understand JSX)
  let grammarName = grammarMap[lang];
  if (filePath && /\.tsx$/i.test(filePath)) {
    grammarName = "tsx";
  }
  const cached = languageCache.get(grammarName);
  if (cached) return cached;

  // Load the grammar WASM by direct file path. The tree-sitter-wasms package
  // `main` field points at a nonexistent `bindings/node`, so importing the
  // package throws; the grammar files live under its out/ directory. Pinned to
  // web-tree-sitter ^0.25.10 because 0.26.x cannot load these grammars (tree-
  // sitter issue #5171 — wasm dylink ABI mismatch with older tree-sitter-cli).
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  const wasmPath = `${pkgJson.slice(0, -"package.json".length)}out/tree-sitter-${grammarName}.wasm`;

  const language = await Language.load(wasmPath);
  languageCache.set(grammarName, language);
  return language;
}

export async function parseFile(file: SourceFile): Promise<Tree | null> {
  if (!file.language) return null;

  // The Parser instance is only a driver — the Tree it returns owns its own
  // native (WASM heap) memory independent of the Parser. So the Parser can
  // (and must) be freed here, right after use, without invalidating the Tree
  // handed back to the caller. Left undeleted, every parsed file leaked one
  // Parser's worth of WASM memory — unbounded under `vibedrift watch`, which
  // reparses the whole tree on every debounced change.
  let parser: Parser | undefined;
  try {
    await ensureInit();
    const language = await getLanguage(file.language, file.relativePath);
    parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(file.content);
    return tree;
  } catch {
    return null;
  } finally {
    parser?.delete();
  }
}

export async function parseFiles(files: SourceFile[]): Promise<void> {
  for (const file of files) {
    if (file.language) {
      file.tree = (await parseFile(file)) ?? undefined;
    }
  }
}

/**
 * Free every parsed AST tree held on `files`, releasing the WASM-backed
 * native memory each Tree owns. Call this once EVERY consumer of
 * `file.tree` for this scan/pipeline pass is done reading it — the
 * analyzers, the drift detectors, and (transitively) Code DNA all read
 * `file.tree` synchronously inside the same pass that calls `parseFiles`;
 * nothing downstream of that pass (scoring, rendering, history, the ML
 * client) touches `.tree`. After this call every `file.tree` is
 * `undefined` and must not be read again for this pass.
 *
 * Idempotent and safe on files with no tree (unsupported language, parse
 * failure) — those are silently skipped.
 */
export function disposeTrees(files: SourceFile[]): void {
  for (const file of files) {
    if (file.tree) {
      file.tree.delete();
      file.tree = undefined;
    }
  }
}
