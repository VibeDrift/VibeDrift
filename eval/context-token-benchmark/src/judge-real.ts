/**
 * judge-real.ts — the METERED blinded judge (claude -p).
 *
 * ⚠ METERED BOUNDARY — PAID CLAUDE API USAGE ⚠
 * buildRealJudge returns a JudgeFn that runs `claude -p <judge prompt>` for ONE
 * turn, with NO tools and in a throwaway temp cwd (so the judge has no codebase
 * access and scores purely from the blinded diff in the prompt). Only call from
 * the gated `judge` subcommand after the spend gate is cleared.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { buildJudgePrompt, type JudgeFn } from "./judge.js";

/**
 * Build a metered JudgeFn. judgeModel should be independent of the agent model
 * where possible (limits self-preference). Returns the model's raw text output;
 * parseJudgeVerdict extracts the JSON from it.
 */
export function buildRealJudge(judgeModel: string): JudgeFn {
  return async (input) => {
    const prompt = buildJudgePrompt(input);
    const dir = await mkdtemp(join(tmpdir(), `judge-${randomBytes(4).toString("hex")}-`));
    try {
      return await new Promise<string>((resolve, reject) => {
        // No --mcp-config (the judge must be blind/tool-less). --max-turns 1:
        // a single-shot judgment, no tool loop. Throwaway cwd: no repo access.
        const args = [
          "-p",
          prompt,
          "--model",
          judgeModel,
          "--max-turns",
          "1",
        ];
        const child = spawn("claude", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stderr.on("data", (c: Buffer) => err.push(c));
        child.on("error", reject);
        child.on("close", (code) => {
          const stdout = Buffer.concat(out).toString("utf-8");
          if (stdout.trim().length === 0 && code !== 0) {
            reject(new Error(`judge claude exited ${code}: ${Buffer.concat(err).toString("utf-8").slice(0, 300)}`));
          } else {
            resolve(stdout);
          }
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
