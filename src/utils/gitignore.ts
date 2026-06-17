import ignore, { type Ignore } from "ignore";
import { readFile } from "fs/promises";
import { join } from "path";

export async function loadGitignore(rootDir: string): Promise<Ignore> {
  const ig = ignore();

  for (const file of [".gitignore", ".vibedriftignore"]) {
    try {
      const content = await readFile(join(rootDir, file), "utf-8");
      ig.add(content);
    } catch {
      // file doesn't exist, skip
    }
  }

  return ig;
}
