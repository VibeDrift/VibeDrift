import { describe, it, expect } from "vitest";
import { runAcceptanceGate } from "../src/gate.js";
import type { CommandRunner } from "../src/gate.js";

function fakeRunner(exitCodes: number[]): CommandRunner {
  let idx = 0;
  return async (_cmd: string, _cwd: string) => {
    if (idx >= exitCodes.length) {
      throw new Error(
        `fakeRunner called more times (${idx + 1}) than scripted (${exitCodes.length})`
      );
    }
    return { exitCode: exitCodes[idx++] };
  };
}

describe("runAcceptanceGate", () => {
  it("pass on first try: passed true, flaky false, attempts 1", async () => {
    const result = await runAcceptanceGate(".", "true", 2, fakeRunner([0]));
    expect(result).toEqual({ passed: true, flaky: false, attempts: 1 });
  });

  it("fail then pass (reruns=2): passed true, flaky true, attempts 2", async () => {
    const result = await runAcceptanceGate(".", "true", 2, fakeRunner([1, 0]));
    expect(result).toEqual({ passed: true, flaky: true, attempts: 2 });
  });

  it("consistently fail (reruns=2): passed false, flaky false, attempts 3", async () => {
    const result = await runAcceptanceGate(".", "true", 2, fakeRunner([1, 1, 1]));
    expect(result).toEqual({ passed: false, flaky: false, attempts: 3 });
  });

  it("fail,fail,pass (reruns=2): passed true, flaky true, attempts 3", async () => {
    const result = await runAcceptanceGate(".", "true", 2, fakeRunner([1, 1, 0]));
    expect(result).toEqual({ passed: true, flaky: true, attempts: 3 });
  });

  it("reruns=0, fail: passed false, flaky false, attempts 1", async () => {
    const result = await runAcceptanceGate(".", "true", 0, fakeRunner([1]));
    expect(result).toEqual({ passed: false, flaky: false, attempts: 1 });
  });
});
