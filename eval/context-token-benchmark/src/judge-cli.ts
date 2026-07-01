/**
 * judge-cli.ts — ⚠ METERED: run the blinded convention judge over stored runs.
 *
 * Reads results.jsonl (RunResults with captured diffs), selects passing runs
 * whose task has conventionTargets, runs an N-judge blinded panel via `claude -p`
 * (judge-real.ts), and appends RunDriftScores to judged.jsonl (resume-capable).
 *
 * Gated like pilot/confirm: do not invoke without clearing the spend gate.
 *
 * Usage: node dist/judge-cli.js [--results results.jsonl] [--judged judged.jsonl]
 *        [--judges 3] [--judge-model claude-opus-4-8] [--judge-all]
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadResults } from "./store.js";
import { loadJsonl, appendJsonl } from "./jsonl.js";
import { loadTasks, tasksById } from "./fixtures.js";
import { selectRunsToJudge, judgeRuns } from "./judge-run.js";
import { buildRealJudge } from "./judge-real.js";
import type { JudgeFn, RunDriftScore } from "./judge.js";

const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES_DIR = join(HARNESS_ROOT, "fixtures");

interface Args {
  results: string;
  judged: string;
  judges: number;
  judgeModel: string;
  judgeAll: boolean;
}

function parseArgs(argv: string[]): Args {
  const a = argv.slice(2);
  let results = "results.jsonl";
  let judged = "judged.jsonl";
  let judges = 3;
  let judgeModel = "claude-opus-4-8";
  let judgeAll = false;
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--results": results = a[++i] ?? results; break;
      case "--judged": judged = a[++i] ?? judged; break;
      case "--judges": judges = parseInt(a[++i] ?? String(judges), 10); break;
      case "--judge-model": judgeModel = a[++i] ?? judgeModel; break;
      case "--judge-all": judgeAll = true; break;
      default: console.error(`Unknown flag: ${a[i]}`); process.exit(1);
    }
  }
  return { results: resolve(results), judged: resolve(judged), judges, judgeModel, judgeAll };
}

export async function runJudgeCli(args: Args, judgeFnFactory: (model: string) => JudgeFn): Promise<void> {
  console.log(
    `[judge] ⚠  METERED — blinded panel (bills Claude API)\n` +
      `        judges=${args.judges} model=${args.judgeModel} judgeAll=${args.judgeAll}\n` +
      `        results ← ${args.results}\n        scores  → ${args.judged}`,
  );

  const runs = await loadResults(args.results);
  const tasks = await loadTasks(FIXTURES_DIR);
  const byId = tasksById(tasks);
  const alreadyJudged = new Set((await loadJsonl<RunDriftScore>(args.judged)).map((s) => s.runId));

  const selection = selectRunsToJudge(runs, byId, alreadyJudged, args.judgeAll);
  console.log(
    `[judge] ${runs.length} runs loaded, ${selection.length} eligible to judge ` +
      `(${alreadyJudged.size} already judged). Panel calls ≈ ${selection.length * args.judges}.`,
  );
  if (selection.length === 0) {
    console.log("[judge] nothing to do.");
    return;
  }

  const judgeFn = judgeFnFactory(args.judgeModel);
  let done = 0;
  await judgeRuns(selection, judgeFn, args.judges, async (score) => {
    await appendJsonl(args.judged, score);
    done++;
    console.log(
      `[judge] ${done}/${selection.length} ${score.runId} drift=${score.driftScore.toFixed(3)} ` +
        `(${score.nJudges} judges, ${score.nJudgeFailures} failed)`,
    );
  });
  console.log(`[judge] Done — ${done} runs judged → ${args.judged}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runJudgeCli(parseArgs(process.argv), buildRealJudge).catch((err) => {
    console.error("[judge] Fatal:", err);
    process.exit(1);
  });
}
