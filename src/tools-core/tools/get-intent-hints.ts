/**
 * get_intent_hints — the team's explicitly declared conventions.
 *
 * Standalone (no baseline needed): parses CLAUDE.md / AGENTS.md / .cursorrules
 * via the existing intent parser and projects each hint into a caller-friendly
 * shape. Confidence is dropped (the caller shouldn't threshold) and each hint is
 * marked `binding: true` — declarations are the team's ground truth and override
 * inferred patterns. Channel-neutral: no transport import.
 */
import { z } from "zod";
import { parseIntentFiles } from "../../intent/parser.js";

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
};

export interface IntentHintOut {
  dimension: string; // IntentHint.category (a drift dimension)
  pattern: string;
  label: string;
  source: string;
  line: number;
  text: string;
  binding: true;
}

export async function run({ rootDir }: { rootDir: string }): Promise<{
  status: "ok";
  hints: IntentHintOut[];
}> {
  const result = await parseIntentFiles(rootDir);
  const hints: IntentHintOut[] = result.hints.map((h) => ({
    dimension: h.category,
    pattern: h.pattern,
    label: h.label,
    source: h.source,
    line: h.line,
    text: h.text,
    binding: true,
  }));
  return { status: "ok", hints };
}
