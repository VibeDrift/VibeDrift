/**
 * MCP-side adapter for the session tee: derive a one-line ask + verdict from a
 * verdict tool's args and result, and record them into the active session
 * ledger (if any). Fail-open — teeing never affects the tool's own result.
 */

import { defaultSessionsDir } from "../session/repo.js";
import { teeMcpVerdict } from "../session/mcp-tee.js";

interface ValidateOut {
  ok?: boolean;
  conflicts?: unknown[];
  duplicateOf?: unknown[];
}
interface DriftOut {
  fits?: boolean | null;
  deviations?: unknown[];
}
interface SimilarOut {
  found?: boolean;
  matches?: unknown[];
}

function short(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}

export async function teeValidateChange(
  args: { rootDir: string; targetPath: string },
  out: ValidateOut,
): Promise<void> {
  const drift = out.conflicts?.length ?? 0;
  const dup = out.duplicateOf?.length ?? 0;
  const verdict =
    out.ok || (drift === 0 && dup === 0)
      ? "in line"
      : [drift ? `${drift} drift` : "", dup ? `${dup} duplicate` : ""].filter(Boolean).join(", ");
  await teeMcpVerdict({
    sessionsDir: defaultSessionsDir(),
    rootDir: args.rootDir,
    tool: "validate_change",
    ask: `validate ${short(args.targetPath)}`,
    verdict,
  });
}

export async function teeCheckFileDrift(
  args: { rootDir: string; filePath: string },
  out: DriftOut,
): Promise<void> {
  const dev = out.deviations?.length ?? 0;
  const verdict = out.fits ? "fits" : dev ? `${dev} deviation${dev === 1 ? "" : "s"}` : "fits";
  await teeMcpVerdict({
    sessionsDir: defaultSessionsDir(),
    rootDir: args.rootDir,
    tool: "check_file_drift",
    ask: `check ${short(args.filePath)}`,
    verdict,
  });
}

export async function teeFindSimilar(
  args: { rootDir: string },
  out: SimilarOut,
): Promise<void> {
  const n = out.matches?.length ?? 0;
  await teeMcpVerdict({
    sessionsDir: defaultSessionsDir(),
    rootDir: args.rootDir,
    tool: "find_similar_function",
    ask: "find a similar existing function",
    verdict: out.found ? `${n} similar found` : "no match",
  });
}
