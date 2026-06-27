import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeUsage } from "../src/usage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("parseClaudeUsage", () => {
  describe("Fixture A: stream with result (authoritative path)", () => {
    const raw = loadFixture("stream-with-result.jsonl");
    const parsed = parseClaudeUsage(raw);

    it("returns cumulative usage from result object", () => {
      expect(parsed.usage).toEqual({
        input_tokens: 5000,
        output_tokens: 800,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 30000,
      });
    });

    it("returns reportedCostUsd from result", () => {
      expect(parsed.reportedCostUsd).toBe(0.42);
    });

    it("counts one compactionEvent", () => {
      expect(parsed.compactionEvents).toBe(1);
    });

    it("returns num_turns from result", () => {
      expect(parsed.turns).toBe(2);
    });

    it("returns modelId from first message_start", () => {
      expect(parsed.modelId).toBe("claude-opus-4-8");
    });
  });

  describe("Fixture B: stream without result (fallback path)", () => {
    const raw = loadFixture("stream-no-result.jsonl");
    const parsed = parseClaudeUsage(raw);

    it("sums input_tokens across messages", () => {
      expect(parsed.usage.input_tokens).toBe(2100);
    });

    it("uses last message_delta output_tokens (cumulative) per message", () => {
      expect(parsed.usage.output_tokens).toBe(450);
    });

    it("sums cache_creation_input_tokens across messages", () => {
      expect(parsed.usage.cache_creation_input_tokens).toBe(500);
    });

    it("sums cache_read_input_tokens across messages", () => {
      expect(parsed.usage.cache_read_input_tokens).toBe(4000);
    });

    it("counts turns from message_start events", () => {
      expect(parsed.turns).toBe(2);
    });

    it("returns null for reportedCostUsd when no result line", () => {
      expect(parsed.reportedCostUsd).toBeNull();
    });

    it("returns zero compactionEvents when none present", () => {
      expect(parsed.compactionEvents).toBe(0);
    });

    it("returns modelId from first message_start", () => {
      expect(parsed.modelId).toBe("claude-opus-4-8");
    });
  });

  describe("Edge cases", () => {
    it("does not throw on blank lines and non-JSON content", () => {
      const mixed = [
        "",
        "   ",
        "not json at all",
        '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
        "partial {json",
        '{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.001,"num_turns":1}',
      ].join("\n");

      expect(() => parseClaudeUsage(mixed)).not.toThrow();
    });

    it("still extracts usage when surrounded by garbage lines", () => {
      const mixed = [
        "garbage line",
        '{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.001,"num_turns":1}',
        "",
        "more garbage",
      ].join("\n");

      const parsed = parseClaudeUsage(mixed);
      expect(parsed.usage.input_tokens).toBe(100);
      expect(parsed.usage.output_tokens).toBe(50);
      expect(parsed.reportedCostUsd).toBe(0.001);
    });

    it("returns zero usage and null modelId for empty input", () => {
      const parsed = parseClaudeUsage("");
      expect(parsed.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      expect(parsed.modelId).toBeNull();
      expect(parsed.reportedCostUsd).toBeNull();
    });

    it("falls back to counting message_start events when result omits num_turns", () => {
      const mixed = [
        '{"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":1}}}',
        '{"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":10}}',
        '{"type":"message_start","message":{"id":"msg-2","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":1}}}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
        '{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.01}',
      ].join("\n");

      const parsed = parseClaudeUsage(mixed);
      expect(parsed.turns).toBe(2);
      expect(parsed.usage.input_tokens).toBe(10);
    });

    it("falls back to system-init for modelId when no message_start present", () => {
      const mixed = [
        '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
        '{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.001,"num_turns":1}',
      ].join("\n");

      const parsed = parseClaudeUsage(mixed);
      expect(parsed.modelId).toBe("claude-opus-4-8");
    });
  });
});
