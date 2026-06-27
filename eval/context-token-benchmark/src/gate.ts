import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
}

export type CommandRunner = (cmd: string, cwd: string) => Promise<CommandResult>;

export interface GateResult {
  passed: boolean;
  flaky: boolean;
  attempts: number;
}

const defaultRunner: CommandRunner = (cmd, cwd) =>
  new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "inherit" });
    child.on("error", () => resolve({ exitCode: 1 }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });

/**
 * Run `cmd` in `cwd`. If it FAILS (exitCode !== 0), re-run up to `reruns` additional
 * times, stopping early as soon as one attempt passes. passed = any attempt passed.
 * flaky = the executed attempts disagree (at least one pass AND at least one fail).
 * `attempts` = number of times the runner was actually invoked.
 */
export async function runAcceptanceGate(
  cwd: string,
  cmd: string,
  reruns: number,
  runner: CommandRunner = defaultRunner
): Promise<GateResult> {
  const results: boolean[] = [];

  // First attempt — always run
  const first = await runner(cmd, cwd);
  const firstPassed = first.exitCode === 0;
  results.push(firstPassed);

  if (firstPassed) {
    return { passed: true, flaky: false, attempts: 1 };
  }

  // Re-run up to `reruns` more times, stop early on first pass
  for (let i = 0; i < reruns; i++) {
    const r = await runner(cmd, cwd);
    const ok = r.exitCode === 0;
    results.push(ok);
    if (ok) break;
  }

  const anyPass = results.some((v) => v);
  const anyFail = results.some((v) => !v);
  const flaky = anyPass && anyFail;

  return { passed: anyPass, flaky, attempts: results.length };
}
