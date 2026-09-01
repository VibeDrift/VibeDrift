import { describe, it, expect } from "vitest";
import { languageSpecificAnalyzer } from "../../../src/analyzers/language-specific.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function makeCtx(files: Partial<SourceFile>[]): AnalysisContext {
  const fullFiles = files.map((f) => ({
    path: f.path ?? "/test/" + f.relativePath,
    relativePath: f.relativePath ?? "test.go",
    language: f.language ?? "go" as const,
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    rootDir: "/test",
    files: fullFiles,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map(),
    dominantLanguage: "go",
  };
}

describe("language-specific analyzer — Go", () => {
  describe("unchecked errors", () => {
    it("does NOT flag err checked a couple of lines later, past an unrelated statement (regression: single-line lookahead)", async () => {
      // The old lookahead only inspected the immediate next line. An
      // unrelated statement (`_ = n`) between the assignment and the actual
      // `if err != nil` check caused a false "unchecked" flag.
      const content = `package main

func do() {
	n, err := compute()
	_ = n
	if err != nil {
		return
	}
}
`;
      const ctx = makeCtx([{ relativePath: "ok.go", content }]);
      const findings = await languageSpecificAnalyzer.analyze(ctx);
      const unchecked = findings.find((f) => f.tags.includes("unchecked-error"));
      expect(unchecked).toBeUndefined();
    });

    // Idiomatic Go handles errors in many shapes besides `if err != nil`.
    // A previous rework required the handling line to START with
    // if/switch/return, which false-flagged every one of these (measured
    // +41% flags on real Go code, 15/15 sampled were false). Each must stay
    // un-flagged.
    const idioms: [string, string][] = [
      ["same-line init form `if err := f(); err != nil {`", `package main

func do() error {
	if err := f(); err != nil {
		return err
	}
	return nil
}
`],
      ["`log.Fatal(err)`", `package main

func main() {
	err := f()
	log.Fatal(err)
}
`],
      ["`t.Fatal(err)`", `package main

func TestX(t *testing.T) {
	err := f()
	t.Fatal(err)
}
`],
      ["`panic(err)`", `package main

func mustDo() {
	err := f()
	panic(err)
}
`],
      ["`errors.Is(err, io.EOF)`", `package main

func read() {
	err := f()
	if errors.Is(err, io.EOF) {
		return
	}
}
`],
      ["`return nil, err` inside a wrapped call", `package main

func load() (*T, error) {
	v, err := f()
	return wrap(v), err
}
`],
      ["check past an unrelated statement (`_ = n`)", `package main

func do() {
	n, err := f()
	_ = n
	if err != nil {
		return
	}
}
`],
    ];
    for (const [name, content] of idioms) {
      it(`does NOT flag ${name}`, async () => {
        const ctx = makeCtx([{ relativePath: "idiom.go", content }]);
        const findings = await languageSpecificAnalyzer.analyze(ctx);
        const unchecked = findings.find((f) => f.tags.includes("unchecked-error"));
        expect(unchecked).toBeUndefined();
      });
    }

    it("flags a genuinely unchecked err (assigned, then never referenced again)", async () => {
      const content = `package main

func bad() error {
	err := f()
	fmt.Println("done")
	return nil
}
`;
      const ctx = makeCtx([{ relativePath: "bad.go", content }]);
      const findings = await languageSpecificAnalyzer.analyze(ctx);
      const unchecked = findings.find((f) => f.tags.includes("unchecked-error"));
      expect(unchecked).toBeDefined();
      expect(unchecked?.locations[0]?.line).toBe(4);
    });

    it("still flags an err assignment with no check at all within the window", async () => {
      const content = `package main

func bad() {
	_, err := compute()
	doSomethingElse()
	doAnotherThing()
	doYetAnotherThing()
	doOneMoreThing()
	fmt.Println("done")
}
`;
      const ctx = makeCtx([{ relativePath: "bad.go", content }]);
      const findings = await languageSpecificAnalyzer.analyze(ctx);
      const unchecked = findings.find((f) => f.tags.includes("unchecked-error"));
      expect(unchecked).toBeDefined();
    });
  });

  describe("naked goroutines (dominance signal)", () => {
    it("does NOT flag naked goroutines when most goroutines in the project never thread context (WaitGroup worker-pool convention)", async () => {
      // Raw heuristic used to flag every goroutine lacking `ctx` nearby,
      // false-firing on idiomatic worker-pool code that never threads
      // context at all. Per AGENTS.md, a finding needs a baseline it
      // deviates from — if the project's own convention is "no context",
      // that's not drift.
      const content = `package main

func run(jobs []Job, wg *sync.WaitGroup) {
	for _, j := range jobs {
		wg.Add(1)
		go func(job Job) {
			defer wg.Done()
			job.Run()
		}(j)
	}
	go worker2()
	go worker3()
	go worker4()
}
`;
      const ctx = makeCtx([{ relativePath: "pool.go", content }]);
      const findings = await languageSpecificAnalyzer.analyze(ctx);
      const naked = findings.find((f) => f.tags.includes("goroutine"));
      expect(naked).toBeUndefined();
    });

    it("flags naked goroutines when a clear majority of the project's goroutines DO thread context", async () => {
      // worker6 is deliberately isolated (3 unrelated lines on each side)
      // so the ±2-line proximity window used to detect nearby context
      // doesn't pick up "ctx" from the sibling goroutines above.
      const content = `package main

func run(ctx context.Context) {
	go worker1(ctx)
	go worker2(ctx)
	go worker3(ctx)
	go worker4(ctx)
	go worker5(ctx)
}

func runNaked() {
	doSetup()
	doSetup()
	doSetup()
	go worker6()
	doTeardown()
	doTeardown()
	doTeardown()
}
`;
      const ctx = makeCtx([{ relativePath: "ctxpool.go", content }]);
      const findings = await languageSpecificAnalyzer.analyze(ctx);
      const naked = findings.find((f) => f.tags.includes("goroutine"));
      expect(naked).toBeDefined();
      expect(naked?.message).toMatch(/1 goroutine/);
    });
  });
});
