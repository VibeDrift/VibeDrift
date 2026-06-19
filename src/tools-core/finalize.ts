/**
 * Channel-neutral finalize step for write-time tools.
 *
 * A successful in-loop deep check resets the nudge clock (`lastDeepScanAt`); when
 * `opts.nudge` is set, a deep-scan nudge may be attached (gated + cooled). The
 * result is plain data: the MCP adapter wraps it with `toToolResult`, an import
 * caller returns it directly, a Skill renders it. The nudge stops being a
 * property of the MCP wire shape and becomes a property of the data.
 */
import { patchConfig } from "../auth/config.js";
import { maybeNudge } from "./nudge.js";
import type { StructuredBase } from "./result.js";

export async function finalizeResult<T extends StructuredBase & { deep?: { degraded: boolean } }>(
  out: T,
  opts: { nudge: boolean },
): Promise<T> {
  if (out.deep && !out.deep.degraded) {
    await patchConfig({ lastDeepScanAt: new Date().toISOString() });
  }
  const extra = opts.nudge ? await maybeNudge() : {};
  return { ...out, ...extra };
}
