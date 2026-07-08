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

async function getLanguage(lang: SupportedLanguage): Promise<Language> {
  const grammarMap: Record<SupportedLanguage, string> = {
    javascript: "javascript",
    typescript: "typescript",
    python: "python",
    go: "go",
    rust: "rust",
  };

  const grammarName = grammarMap[lang];
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

  try {
    await ensureInit();
    const language = await getLanguage(file.language);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(file.content);
    return tree;
  } catch {
    return null;
  }
}

export async function parseFiles(files: SourceFile[]): Promise<void> {
  for (const file of files) {
    if (file.language) {
      file.tree = (await parseFile(file)) ?? undefined;
    }
  }
}
