import { describe, it, expect } from "vitest";
import { normalizeHookPayload, EDIT_TOOLS } from "@/session/normalize";

const base = { session_id: "s1", cwd: "/tmp/x" };
const ctx = { projectHash: "abcd1234abcd1234" };

describe("normalizeHookPayload", () => {
  it("maps SessionStart and Stop/SessionEnd", () => {
    expect(normalizeHookPayload({ ...base, hook_event_name: "SessionStart" }, ctx)?.type).toBe(
      "session_start",
    );
    expect(normalizeHookPayload({ ...base, hook_event_name: "Stop" }, ctx)?.type).toBe(
      "session_end",
    );
    expect(normalizeHookPayload({ ...base, hook_event_name: "SessionEnd" }, ctx)?.type).toBe(
      "session_end",
    );
  });

  it("maps UserPromptSubmit and masks the prompt", () => {
    const ev = normalizeHookPayload(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "use api_key=abcd1234efgh5678 now" },
      ctx,
    );
    expect(ev?.type).toBe("user_prompt");
    expect(ev?.detail.promptText).toContain("[masked]");
    expect(ev?.detail.promptText).not.toContain("abcd1234efgh5678");
  });

  it("accepts user_prompt as an alternate prompt key (docs gap)", () => {
    const ev = normalizeHookPayload(
      { ...base, hook_event_name: "UserPromptSubmit", user_prompt: "hello" },
      ctx,
    );
    expect(ev?.detail.promptText).toBe("hello");
  });

  it("maps PostToolUse Edit with new_string body and line-count diffstat", () => {
    const ev = normalizeHookPayload(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/x/src/a.ts", old_string: "a", new_string: "line1\nline2" },
      },
      ctx,
    );
    expect(ev?.type).toBe("edit");
    expect(ev?.detail.file).toBe("/tmp/x/src/a.ts");
    expect(ev?.detail.diffstat).toBe("+2");
    expect(ev?.detail.toolName).toBe("Edit");
  });

  it("maps Write content and file_text variants", () => {
    const w1 = normalizeHookPayload(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x/b.ts", content: "x\ny\nz" },
      },
      ctx,
    );
    expect(w1?.detail.diffstat).toBe("+3");
    const w2 = normalizeHookPayload(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/x/b.ts", file_text: "x\ny" },
      },
      ctx,
    );
    expect(w2?.detail.diffstat).toBe("+2");
  });

  it("maps MultiEdit by joining edits", () => {
    const m = normalizeHookPayload(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "/tmp/x/c.ts",
          edits: [
            { old_string: "", new_string: "p" },
            { old_string: "", new_string: "q" },
          ],
        },
      },
      ctx,
    );
    expect(m?.type).toBe("edit");
    expect(m?.detail.file).toBe("/tmp/x/c.ts");
  });

  it("maps PostToolUse Bash to command without recording the command text", () => {
    const ev = normalizeHookPayload(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf secrets/" },
      },
      ctx,
    );
    expect(ev?.type).toBe("command");
    expect(JSON.stringify(ev)).not.toContain("rm -rf");
  });

  it("returns null for unknown events, other tools, and missing session_id", () => {
    expect(normalizeHookPayload({ ...base, hook_event_name: "Notification" }, ctx)).toBeNull();
    expect(
      normalizeHookPayload(
        { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} },
        ctx,
      ),
    ).toBeNull();
    expect(normalizeHookPayload({ hook_event_name: "SessionStart" }, ctx)).toBeNull();
    expect(normalizeHookPayload("not an object", ctx)).toBeNull();
    expect(normalizeHookPayload(null, ctx)).toBeNull();
  });

  it("exports the edit tool list", () => {
    expect(EDIT_TOOLS).toEqual(["Edit", "Write", "MultiEdit"]);
  });
});
