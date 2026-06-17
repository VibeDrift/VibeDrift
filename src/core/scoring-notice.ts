/**
 * One-time "scoring refined" notice.
 *
 * Replaces the rejected per-scan version-mismatch banner. Users must stay
 * agnostic of internal scoring versions (see memory: silent-score-migration).
 * When VibeDrift's scoring methodology changes between releases, stored scores
 * are re-aligned where possible and the user sees ONE low-noise notice linking
 * the release notes — never a repeated banner, never an internal version
 * string.
 *
 * This module holds the pure decision + message. The IO (reading/writing
 * `lastSeenScoringVersion` in ~/.vibedrift/config.json) lives at the call site
 * in the scan command so this stays trivially testable.
 */

export function shouldShowScoringNotice(opts: {
  /** The scoring version the user last acknowledged (from config). */
  lastSeen: string | undefined;
  /** The current SCORING_VERSION this CLI computes with. */
  current: string;
  /** Whether the user has any prior scan history on this machine. */
  hasPriorHistory: boolean;
}): boolean {
  const { lastSeen, current, hasPriorHistory } = opts;
  // Already acknowledged this version — never repeat.
  if (lastSeen === current) return false;
  // Brand-new user (never scanned, never recorded a version): there is no
  // older score to re-align and nothing to announce. Just record silently.
  if (lastSeen === undefined && !hasPriorHistory) return false;
  // Either the version changed, or an existing user is crossing into the
  // versioning system for the first time — announce once.
  return true;
}

export function scoringNoticeLine(): string {
  return (
    "We refined how the Vibe Drift Score is calculated this release. " +
    "Your past scans were recomputed under the new scoring so your trends stay comparable. " +
    "What changed → https://vibedrift.ai/releases"
  );
}
