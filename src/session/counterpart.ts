import { extractFunctionsFromFile } from "../codedna/function-extractor.js";
import type { SupportedLanguage } from "../core/types.js";

/**
 * Whether the function a duplicate advisory is about to cite is still where the
 * baseline says it is.
 *
 * `gone` means the advisory must be suppressed: the agent MOVED the code rather
 * than duplicating it.
 */
export type CounterpartStatus =
  | { status: "confirmed"; line: number }
  | { status: "moved"; line: number }
  | { status: "gone" };

/**
 * Verify a duplicate counterpart against the file as it stands right now.
 *
 * Why this exists. The minhash index is built once and then used for the whole
 * session, so by the time an advisory fires, the counterpart it names may have
 * moved or ceased to exist. The measured case: in a recorded session the
 * agent lifted a DOM helper `el` out of `src/content/composer.ts` into
 * `src/shared/dom.ts`. The duplicate match was CORRECT — same function, 42
 * tokens either side — but by then `el` was gone from composer.ts, so the
 * advisory's "prefer importing it" pointed at nothing. The same shape hit a URL
 * helper in the same session.
 *
 * A move is not a duplication, and telling an agent to import from a file it
 * just emptied is worse than saying nothing. So:
 *
 *   confirmed — the function is still at the indexed line. Cite it as is.
 *   moved     — still in the file, at a different line. Cite the new line.
 *   gone      — not in the file any more. Suppress the advisory.
 *
 * Fail-open is deliberate on both error paths. An unreadable file or a language
 * the extractor cannot parse returns `confirmed`, preserving the previous
 * behaviour, because a read failure must never silently switch duplicate
 * detection off across a whole session.
 */
export function verifyCounterpart(args: {
  name: string;
  relativePath: string;
  line: number;
  /** Contents of `relativePath` right now, or null when it could not be read. */
  fileContent: string | null;
  language: SupportedLanguage | null;
}): CounterpartStatus {
  const { name, relativePath, line, fileContent, language } = args;
  if (fileContent === null || language === null) return { status: "confirmed", line };

  let fns: ReturnType<typeof extractFunctionsFromFile>;
  try {
    fns = extractFunctionsFromFile({
      path: relativePath,
      relativePath,
      content: fileContent,
      language,
    } as Parameters<typeof extractFunctionsFromFile>[0]);
  } catch {
    return { status: "confirmed", line };
  }

  const matches = fns.filter((f) => f.name === name);
  if (matches.length === 0) return { status: "gone" };
  if (matches.some((f) => f.line === line)) return { status: "confirmed", line };
  // Name still present but relocated. Cite the closest surviving definition so
  // the agent is pointed at a line that actually holds the function.
  const nearest = matches.reduce((a, b) => (Math.abs(a.line - line) <= Math.abs(b.line - line) ? a : b));
  return { status: "moved", line: nearest.line };
}
