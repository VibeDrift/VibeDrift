import { parseFile } from "../../src/utils/ast.js";
import type { DriftFile } from "../../src/drift/types.js";

export async function fileWithTree(
  path: string,
  content: string,
  language: "javascript" | "typescript" = "typescript",
): Promise<DriftFile> {
  const tree = await parseFile({
    path, relativePath: path, language, content, lineCount: content.split("\n").length,
  });
  return { relativePath: path, language, content, lineCount: content.split("\n").length, tree: tree ?? undefined };
}
