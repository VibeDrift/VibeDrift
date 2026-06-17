import { describe, it, expect } from "vitest";
import { runEval } from "../../eval/orchestrate.js";
import { StubRunner } from "../../eval/runner-stub.js";
import { loadTasks, repoDir } from "../../eval/fixtures.js";

const asyncTasks = loadTasks().filter((t) => t.repo === "async-await-repo").slice(0, 2);

describe("runEval (deterministic, with StubRunner over the real scanner)", () => {
  it("produces a positive delta — stub drifts under 'none', conforms under 'context'", async () => {
    const report = await runEval(asyncTasks, new StubRunner(), {
      trials: 2, control: "none", treatment: "context", resolveRepoDir: repoDir,
    });
    expect(report.tasks).toHaveLength(2);
    expect(report.meanDriftControl).toBeGreaterThan(0);
    expect(report.meanDriftTreatment).toBeLessThan(report.meanDriftControl);
    expect(report.delta).toBeGreaterThan(0);
    expect(report.scoringVersion).toBeTruthy();
    expect(report.tasks[0].example?.controlBody).toContain(".then(");
    expect(report.tasks[0].example?.treatmentBody).toContain("await ");
  });

  it("deterministic stub → zero stdev across trials", async () => {
    const report = await runEval(asyncTasks.slice(0, 1), new StubRunner(), {
      trials: 3, control: "none", treatment: "context", resolveRepoDir: repoDir,
    });
    expect(report.tasks[0].control.stdevDrift).toBe(0);
    expect(report.tasks[0].control.trials).toBe(3);
  });
});
