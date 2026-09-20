/**
 * The mid-turn flush cadence.
 *
 * The behaviour under test is a promise about latency: a session that keeps
 * editing ships what it has about once a minute, instead of going dark until
 * the turn ends. Measured before this existed, batches reached the dashboard
 * 14 to 25 minutes apart.
 *
 * Every case here is also a statement about failing safely. The cadence gate
 * sits on the hook's path, which runs on every edit, so "when in doubt, do
 * nothing" is the rule: an unreadable marker must read as not-due, never as
 * due, or a broken filesystem becomes a child process per keystroke.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MID_TURN_FLUSH_MS,
  dueForFlush,
  flushMarkerPath,
  markFlushed,
} from "../../src/session/flush-cadence.js";

let dir: string;
const SID = "sess-1";
const WS = "workspacehash01";
const NOW = Date.parse("2026-09-20T12:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vd-cadence-"));
  mkdirSync(join(dir, WS));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a session ships what it has, about once a minute", () => {
  it("is due on the first edit, so a session appears while it is still running", () => {
    expect(dueForFlush(dir, WS, SID, NOW)).toBe(true);
  });

  it("is not due again immediately after a flush", () => {
    markFlushed(dir, WS, SID, NOW);
    expect(dueForFlush(dir, WS, SID, NOW)).toBe(false);
    expect(dueForFlush(dir, WS, SID, NOW + MID_TURN_FLUSH_MS - 1)).toBe(false);
  });

  it("is due once the window has passed", () => {
    markFlushed(dir, WS, SID, NOW);
    expect(dueForFlush(dir, WS, SID, NOW + MID_TURN_FLUSH_MS)).toBe(true);
  });

  it("keeps the cadence inside the dashboard's own live window", () => {
    // The dashboard polls a live session every 10s and calls it live for 15
    // minutes. A cadence outside that would put the tape behind the poll or
    // the session outside its own live reading.
    expect(MID_TURN_FLUSH_MS).toBeGreaterThanOrEqual(10_000);
    expect(MID_TURN_FLUSH_MS).toBeLessThan(15 * 60_000);
  });
});

describe("one marker per session, not per repo", () => {
  it("keeps two sessions independent", () => {
    markFlushed(dir, WS, "a", NOW);
    expect(dueForFlush(dir, WS, "a", NOW)).toBe(false);
    expect(dueForFlush(dir, WS, "b", NOW)).toBe(true);
  });

  it("never lets a session id escape its own directory", () => {
    const p = flushMarkerPath(dir, WS, "../../etc/passwd");
    expect(p.startsWith(join(dir, WS))).toBe(true);
    // The segment keeps no separator, so whatever survives sanitising is a
    // file name rather than a path. That is the property; a literal ".."
    // inside a name cannot traverse anything.
    expect(p.slice(join(dir, WS).length + 1)).not.toMatch(/[/\\]/);
  });
});

describe("it fails in the direction of doing less", () => {
  it("reads a marker stamped in the future as due, rather than waiting out a bad clock", () => {
    markFlushed(dir, WS, SID, NOW + 60 * 60_000);
    expect(dueForFlush(dir, WS, SID, NOW)).toBe(true);
  });

  it("treats an unreadable marker as not due, so a broken disk is not a spawn storm", () => {
    // A sessions dir we cannot read: stat throws EACCES rather than ENOENT.
    // "Due" here would mean a spawned child on every edit, forever.
    const locked = join(dir, "locked");
    mkdirSync(join(locked, WS), { recursive: true });
    markFlushed(locked, WS, SID, NOW);
    chmodSync(locked, 0o000);
    try {
      expect(dueForFlush(locked, WS, SID, NOW + MID_TURN_FLUSH_MS * 10)).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("does not throw when the sessions dir cannot be written", () => {
    const missing = join(dir, "no", "such", "dir");
    expect(() => markFlushed(missing, WS, SID, NOW)).not.toThrow();
    expect(dueForFlush(missing, WS, SID, NOW)).toBe(true);
  });

  it("stamps the marker at the time it is told, not at wall clock", () => {
    markFlushed(dir, WS, SID, NOW);
    const stamped = statSync(flushMarkerPath(dir, WS, SID)).mtimeMs;
    expect(Math.abs(stamped - NOW)).toBeLessThan(1000);
  });

  it("overwrites an existing marker rather than appending to it", () => {
    writeFileSync(flushMarkerPath(dir, WS, SID), "stale");
    markFlushed(dir, WS, SID, NOW + 5_000);
    expect(dueForFlush(dir, WS, SID, NOW + 5_000)).toBe(false);
  });
});
