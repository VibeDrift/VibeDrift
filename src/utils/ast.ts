import { Parser, Language } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import type { SupportedLanguage, SourceFile } from "../core/types.js";

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

  const wasmModule = await import("tree-sitter-wasms");
  const wasmPath =
    (wasmModule as Record<string, string>)[`tree_sitter_${grammarName}`] ??
    (wasmModule.default as Record<string, string>)?.[
      `tree_sitter_${grammarName}`
    ];

  if (!wasmPath) {
    throw new Error(`No WASM grammar found for language: ${lang}`);
  }

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
