import type { SupportedLanguage } from "./types.js";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return EXTENSION_MAP[ext] ?? null;
}

export function getLanguageDisplayName(lang: SupportedLanguage): string {
  const names: Record<SupportedLanguage, string> = {
    javascript: "JS",
    typescript: "TS",
    python: "Python",
    go: "Go",
    rust: "Rust",
  };
  return names[lang];
}
