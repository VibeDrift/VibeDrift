import { describe, it, expect } from "vitest";
import { toUploadEvent, UPLOAD_SCHEMA_VERSION } from "@/session/upload-schema";
import type { SessionEvent, SessionEventType } from "@/session/types";

// Sentinels planted in banned fields. Paths, the advisory-to-agent text, and
// secrets must NEVER leave the machine in any state. Prompt CONTENT must be fully
// local by default; under team opt-in, derived anchor tokens may ship but never
// the verbatim sentence.
const PATH = "src/SECRETPATHSEGMENT/module.ts";
const ABS_PATH = "/Users/someone/SECRETPATHSEGMENT/module.ts";
const SIMILAR = "src/SECRETPATHSEGMENT/other.ts";
const MSG = "MSGTOAGENTSECRET [vibedrift] flagged foo";
// fake key assembled from parts so no contiguous secret literal appears in source
const APIKEY = ["sk-", "ant-", "api03-", "AAAABBBBCCCCDDDD1234"].join("");
const PROMPT = "PROMPTSENTENCESECRET add billing to the customer service";

// never leaks in ANY state
const BANNED_ALWAYS = ["SECRETPATHSEGMENT", "MSGTOAGENTSECRET", APIKEY];

let seq = 0;
const ev = (type: SessionEventType, over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "sess-1",
  aid: `evt-${seq++}`,
  ts: "2026-07-21T10:00:00.000Z",
  agent: "claude-code",
  projectHash: "abc123hash",
  channel: "hook",
  type,
  mode: "passive",
  detail: {},
  ...over,
});

// One representative-but-hostile event per uploadable kind: every path/free-text
// field stuffed with a sentinel, plus a top-level msgToAgent and a live-looking key.
const HOSTILE: SessionEvent[] = [
  ev("session_start", { detail: { promptText: PROMPT } }),
  ev("intent_lock", { detail: { promptText: PROMPT, anchorFiles: [PATH, ABS_PATH], observed: "expanded" } }),
  ev("edit", { detail: { file: ABS_PATH, diffstat: "+38 -4", promptText: PROMPT } }),
  ev("flag", {
    findingId: "DF-1",
    msgToAgent: MSG,
    detail: { file: PATH, category: "async_patterns", dominant: "async/await", observed: ".then() chains", similarity: 0.9 },
  }),
  ev("flag", {
    findingId: "DF-2",
    msgToAgent: MSG,
    detail: { file: PATH, category: "redundancy", similarTo: `${SIMILAR}:12`, similarity: 0.88 },
  }),
  ev("resolve", { findingId: "DF-1", detail: { file: PATH }, outcome: "resolved" }),
  ev("hold", { findingId: "DF-3", detail: { file: PATH } }),
  ev("mcp_ask", { channel: "mcp", detail: { toolName: "validate_change", promptText: `validate ${PATH}` } }),
  ev("mcp_verdict", { channel: "mcp", detail: { toolName: "validate_change", observed: "1 drift: async" } }),
  ev("decision", { channel: "mcp", findingId: "DF-1", detail: { decision: "decline", reason: `keep it, ${APIKEY} is a dev DSN` } }),
  ev("session_end", {}),
];

describe("toUploadEvent — derived-only invariant", () => {
  for (const teamIntentOptIn of [false, true]) {
    it(`never leaks a path, advisory text, or secret (teamIntentOptIn=${teamIntentOptIn})`, () => {
      for (const source of HOSTILE) {
        const mapped = toUploadEvent(source, { teamIntentOptIn });
        if (mapped === null) continue;
        const json = JSON.stringify(mapped);
        for (const banned of BANNED_ALWAYS) {
          expect(json, `${source.type} leaked "${banned}"`).not.toContain(banned);
        }
        expect(mapped.v).toBe(UPLOAD_SCHEMA_VERSION);
        expect(mapped.sessionId).toBe("sess-1");
      }
    });
  }

  it("keeps prompt content fully local by default (opt-in OFF)", () => {
    for (const source of HOSTILE) {
      const mapped = toUploadEvent(source, { teamIntentOptIn: false });
      if (mapped === null) continue;
      expect(JSON.stringify(mapped), `${source.type} leaked prompt content`).not.toContain("PROMPTSENTENCESECRET");
    }
  });

  it("never ships the prompt SENTENCE verbatim, even under team opt-in", () => {
    const src = ev("intent_lock", { detail: { promptText: PROMPT, anchorFiles: ["a.ts"] } });
    const on = toUploadEvent(src, { teamIntentOptIn: true })!;
    // a derived label may exist (anchor tokens), but never the contiguous sentence
    expect(on.taskLabel ?? "").not.toContain("add billing to the customer service");
    expect(on.taskLabel ?? "").not.toContain("PROMPTSENTENCESECRET add");
  });

  it("drops non-uploadable event kinds (user_prompt, command, recheck)", () => {
    expect(toUploadEvent(ev("user_prompt", { detail: { promptText: PROMPT } }))).toBeNull();
    expect(toUploadEvent(ev("command", { detail: { promptText: PROMPT } }))).toBeNull();
    expect(toUploadEvent(ev("recheck", { detail: { file: PATH } }))).toBeNull();
  });

  it("carries a file as a hash, never the path", () => {
    const m = toUploadEvent(ev("edit", { detail: { file: ABS_PATH, diffstat: "+5" } }))!;
    expect(m.fileHash).toMatch(/^[0-9a-f]{16}$/);
    expect(m.fileHash).not.toContain("SECRETPATHSEGMENT");
    expect(m.diffLines).toBe(5);
  });

  it("keeps derived labels and finding metadata on a flag", () => {
    const m = toUploadEvent(
      ev("flag", { findingId: "DF-1", mode: "passive", detail: { file: PATH, category: "async_patterns", dominant: "async/await", observed: ".then() chains", similarity: 0.9 } }),
    )!;
    expect(m).toMatchObject({
      type: "flag",
      category: "async_patterns",
      dominant: "async/await",
      observed: ".then() chains",
      similarity: 0.9,
      findingId: "DF-1",
      mode: "passive",
    });
    expect(m.fileHash).toBeDefined();
  });

  it("carries the decision label always; the reason only under team opt-in (and masked)", () => {
    const src = ev("decision", { findingId: "DF-1", detail: { decision: "decline", reason: `real reasoning but ${APIKEY} leaks` } });

    const off = toUploadEvent(src, { teamIntentOptIn: false })!;
    expect(off.decision).toBe("decline");
    expect(off.reason).toBeUndefined(); // free text stays local by default

    const on = toUploadEvent(src, { teamIntentOptIn: true })!;
    expect(on.decision).toBe("decline");
    expect(on.reason).toContain("real reasoning");
    expect(on.reason).not.toContain(APIKEY); // masked even under opt-in
  });

  it("secret-masks label fields (defense in depth) but leaves a real slash-bearing label", () => {
    const m = toUploadEvent(
      ev("flag", { findingId: "DF-1", detail: { category: "async_patterns", dominant: "async/await", observed: `.then() ${APIKEY}` } }),
    )!;
    expect(m.observed).not.toContain("AAAABBBBCCCCDDDD1234");
    expect(m.observed).toContain("[masked]");
    expect(m.dominant).toBe("async/await"); // a legit "/"-bearing label is untouched
  });

  it("secret-masks a taskLabel derived from a prompt (opt-in)", () => {
    const src = ev("intent_lock", { detail: { promptText: `add OPENAI_API_KEY=${APIKEY} to config`, anchorFiles: ["a.ts"] } });
    const on = toUploadEvent(src, { teamIntentOptIn: true })!;
    expect(on.taskLabel ?? "").not.toContain("AAAABBBBCCCCDDDD1234");
  });

  it("salts the file hash per repo — stable within a repo, different across repos", () => {
    const mk = (repo: string) => toUploadEvent({ ...ev("edit"), projectHash: repo, detail: { file: "src/x.ts" } })!;
    expect(mk("repoA").fileHash).toBe(mk("repoA").fileHash); // stable → group-able
    expect(mk("repoA").fileHash).not.toBe(mk("repoB").fileHash); // salted → no global rainbow
  });

  it("intent_lock ships a file COUNT always, and a token-derived label only under opt-in", () => {
    const src = ev("intent_lock", { detail: { promptText: "add `retryWebhook` to billing.ts and orders.ts", anchorFiles: ["billing.ts", "orders.ts"] } });

    const off = toUploadEvent(src, { teamIntentOptIn: false })!;
    expect(off.taskFileCount).toBe(2);
    expect(off.taskLabel).toBeUndefined();

    const on = toUploadEvent(src, { teamIntentOptIn: true })!;
    expect(on.taskFileCount).toBe(2);
    expect(on.taskLabel).toBeDefined();
  });
});
