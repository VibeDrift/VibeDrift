import { describe, it, expect } from "vitest";
import {
  extractFunctionsFromFile,
  extractAllFunctions,
  tokenizeBody,
} from "../../../src/codedna/function-extractor.js";
import {
  computeSemanticFingerprints,
  findDuplicateGroups,
} from "../../../src/codedna/semantic-fingerprint.js";
import type { SourceFile, SupportedLanguage } from "../../../src/core/types.js";

function mkFile(
  content: string,
  language: SupportedLanguage = "typescript",
  relativePath = "src/x.ts",
): SourceFile {
  return {
    path: `/abs/${relativePath}`,
    relativePath,
    language,
    content,
    lineCount: content.split("\n").length,
  };
}

/**
 * Regression suite for the body-extraction bug behind Anishek Kamal's
 * 0.14.0 complaint on bandcamp-player-extension.
 *
 * Root cause: the TS `function` regex encoded the return type as
 * `(?::\s*[^{]*)?` before the body brace. `[^{]*` cannot span a return type
 * that itself contains `{` — e.g. `: { value: string; source: string }` —
 * so the FIRST `{` the regex matched as "the body brace" was actually the
 * return-type object's brace. extractBody then captured the return-type
 * annotation (~8 tokens) instead of the real ~50-line body. Every function
 * sharing a `{ value; source }` return shape collapsed to an identical
 * truncated body → identical hash → a false "exact semantic duplicate".
 */
describe("extractFunctionsFromFile — return types containing braces (Bug A)", () => {
  it("captures the real body, not the inline-object return-type annotation", () => {
    const src = `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  if (!raw) {
    return { value: "", source: "missing" };
  }
  const decoded = decodeURIComponent(raw);
  const parsed = JSON.parse(decoded);
  return { value: parsed.crumb, source: "attribute" };
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "readMutationCrumb",
    );
    expect(fn).toBeDefined();
    // The body must contain the implementation, not the type annotation.
    expect(fn!.rawBody).toContain("getAttribute");
    expect(fn!.rawBody).toContain("decodeURIComponent");
    expect(fn!.rawBody).toContain("JSON.parse");
    // The return-type annotation alone is ~8 tokens; the real body is far more.
    expect(fn!.bodyTokenCount).toBeGreaterThan(20);
  });

  it("two functions sharing a return shape but with different bodies get different hashes", () => {
    // This is THE false-positive: before the fix both captured the identical
    // `{ value: string; source: string }` annotation → identical bodyHash →
    // reported as an exact duplicate that does not exist.
    const src = `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  return { value: decodeURIComponent(raw ?? ""), source: "attribute" };
}
export function readTitleFromTrackRecord(rec: TrackRecord): { value: string; source: string } {
  const title = rec.current && rec.current.title;
  return { value: title ?? "", source: "trackRecord" };
}
`;
    const fns = extractFunctionsFromFile(mkFile(src));
    const a = fns.find((f) => f.name === "readMutationCrumb");
    const b = fns.find((f) => f.name === "readTitleFromTrackRecord");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.bodyHash).not.toBe(b!.bodyHash);
  });

  it("handles a Promise<{...}> return type", () => {
    const src = `
export async function readRootCrumb(doc: Document): Promise<{ value: string; source: string }> {
  const resp = await fetch("/api/crumb");
  const json = await resp.json();
  return { value: json.crumb, source: "fetch" };
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "readRootCrumb",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("fetch");
    expect(fn!.rawBody).toContain("resp.json");
  });

  it("handles a union return type with an inline object member", () => {
    const src = `
function classify(x: number): string | { tag: string } {
  logIt(x);
  return String(x);
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "classify",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("logIt");
    expect(fn!.rawBody).toContain("String");
  });

  it("handles a generic function with type parameters", () => {
    const src = `
function identity<T>(value: T): T {
  const copy = value;
  return copy;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "identity",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("copy");
  });

  it("handles an arrow function with an inline-object return type", () => {
    const src = `
const buildPair = (k: string): { value: string; source: string } => {
  const v = lookup(k);
  return { value: v, source: "arrow" };
};
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "buildPair",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("lookup");
  });

  // ── Regression guards: the common cases must keep working ──

  it("still extracts a simple primitive return type", () => {
    const src = `
function add(a: number, b: number): number {
  const sum = a + b;
  return sum;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find((f) => f.name === "add");
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("sum");
  });

  it("still extracts a function with no return type", () => {
    const src = `
function greet(name: string) {
  const msg = "hello " + name;
  return msg;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find((f) => f.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("msg");
  });

  it("does not mis-extract overload signatures as tiny bodies", () => {
    const src = `
function parse(x: string): number;
function parse(x: number): string;
function parse(x: any): any {
  const result = transform(x);
  return result;
}
`;
    const parses = extractFunctionsFromFile(mkFile(src)).filter(
      (f) => f.name === "parse",
    );
    expect(parses.length).toBe(1);
    expect(parses[0].rawBody).toContain("transform");
  });
});

describe("extractor × fingerprint (regression: shared return shape ≠ duplicate)", () => {
  it("does not group two functions that only share a return-type annotation", () => {
    const fileA = mkFile(
      `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  const decoded = decodeURIComponent(raw ?? "");
  return { value: decoded, source: "attribute" };
}
`,
      "typescript",
      "src/mutations.ts",
    );
    const fileB = mkFile(
      `
export function readTitleFromTrackRecord(rec: any): { value: string; source: string } {
  const title = rec && rec.current && rec.current.title;
  const trimmed = (title ?? "").trim();
  return { value: trimmed, source: "trackRecord" };
}
`,
      "typescript",
      "src/track-index.ts",
    );
    const fns = extractAllFunctions([fileA, fileB]);
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    // Different bodies → no exact-duplicate group. Before the fix both bodies
    // collapsed to `{ value: string; source: string }` → one false group.
    expect(groups.length).toBe(0);
  });
});

describe("tokenizeBody strips comments and literals in one pass", () => {
  // Strings and comments are recognised in a single left-to-right pass, so
  // neither can open the other. Stripping `//` first read the `//` inside a
  // literal as a comment, deleted the closing quote and desynchronized quote
  // pairing for the rest of the body (measured: 45 English words leaked out of
  // test-name literals into one anchor; 43% of another file's tokens swallowed).
  // Stripping strings first had the mirror bug: an apostrophe in a comment
  // paired with the next quote and swallowed the real code in between.
  it("an apostrophe inside a line comment does not swallow the following code", () => {
    const toks = tokenizeBody(
      ["// don't do this", "const keepMe = compute(1);", "const label = 'x';", "return keepMe;"].join("\n"),
    );
    expect(toks).toContain("keepMe");
    expect(toks).toContain("compute");
    expect(toks).toContain("label");
    expect(toks).toContain("return");
    expect(toks).not.toContain("don");
  });

  it("a block comment containing `//` and an apostrophe is stripped whole", () => {
    const toks = tokenizeBody(["/* it's at https://x.y // honest */", "const after = 1;"].join("\n"));
    expect(toks).toContain("after");
    expect(toks).not.toContain("honest");
    expect(toks).not.toContain("it");
  });

  it("does not treat a URL inside a single-quoted string as a line comment", () => {
    const toks = tokenizeBody(`const u = 'https://example.invalid'; const after = 1;`);
    expect(toks).toContain("after");
    expect(toks).not.toContain("example");
    expect(toks).not.toContain("invalid");
  });

  it("does not treat a URL inside a template literal as a line comment", () => {
    const toks = tokenizeBody("const p = `https://picsum.photos/x`; const tail = 9;");
    expect(toks).toContain("tail");
    expect(toks).not.toContain("picsum");
  });

  it("does not treat a URL inside a double-quoted string as a line comment", () => {
    const toks = tokenizeBody(`const u = "https://example.invalid"; const tail = 2;`);
    expect(toks).toContain("tail");
    expect(toks).not.toContain("invalid");
  });

  it("still strips a genuine line comment", () => {
    const toks = tokenizeBody(`const a = 1; // secretName\nconst b = 2;`);
    expect(toks).not.toContain("secretName");
    expect(toks).toContain("b");
  });

  it("still strips a block comment", () => {
    const toks = tokenizeBody(`const a = 1; /* hiddenName */ const b = 2;`);
    expect(toks).not.toContain("hiddenName");
    expect(toks).toContain("b");
  });

  it("still strips a python hash comment", () => {
    const toks = tokenizeBody(`a = 1  # pythonSecret\nb = 2`);
    expect(toks).not.toContain("pythonSecret");
    expect(toks).toContain("b");
  });
});

describe("JS/TS extraction coverage", () => {
  const names = (content: string, language: SupportedLanguage = "typescript") =>
    extractFunctionsFromFile(mkFile(content, language)).map((f) => f.name);

  it("indexes class methods", () => {
    expect(
      names(`class Repo {\n  async findUser(id: string) {\n    const row = await db.get(id);\n    return row ?? null;\n  }\n}`),
    ).toContain("findUser");
  });

  it("indexes object-literal methods", () => {
    expect(
      names(`const api = {\n  fetchUser(id: string) {\n    const row = lookup(id);\n    return row ?? null;\n  },\n};`),
    ).toContain("fetchUser");
  });

  it("indexes let and var arrow bindings", () => {
    expect(
      names(`let handle = (e: Event) => {\n  const t = e.target;\n  return t ?? null;\n};`),
    ).toContain("handle");
  });

  it("indexes generators and accessors", () => {
    const n = names(
      `class C {\n  *walk() {\n    const a = 1;\n    yield a;\n  }\n  get total() {\n    const n = this.items.length;\n    return n * 2;\n  }\n}`,
    );
    expect(n).toContain("walk");
    expect(n).toContain("total");
  });

  it("indexes an exported default function", () => {
    expect(
      names(`export default function handler(req: Req) {\n  const id = req.query.id;\n  return id ?? null;\n}`),
    ).toContain("handler");
  });

  // ---- over-matching guards. These must pass BEFORE and AFTER the widening. ----

  it("does not index an interface member as a function", () => {
    // The exact shape that made a duplicate advisory cite a non-function.
    expect(names(`interface Opts {\n  onSave(body: string): void;\n  onCancel(): void;\n}`)).toHaveLength(0);
  });

  it("does not index a type-literal member as a function", () => {
    expect(names(`type Handlers = {\n  onSave(body: string): void;\n  onCancel(): void;\n};`)).toHaveLength(0);
  });

  it("does not index control-flow keywords as functions", () => {
    const n = names(
      `function real() {\n  if (a) { doThing(); }\n  for (const x of xs) { use(x); }\n  while (y) { tick(); }\n  switch (z) { default: break; }\n  return 1;\n}`,
    );
    expect(n).toEqual(["real"]);
  });

  it("does not index a bare call expression as a function", () => {
    const n = names(`function real() {\n  const a = compute(1, 2);\n  register(a);\n  return a;\n}`);
    expect(n).toEqual(["real"]);
  });

  it("does not index a test-runner call whose argument is an arrow", () => {
    // The dangerous over-match for a method-shorthand pattern: `describe("x", () => {`
    // has the shape name(args) followed by a block, but the block belongs to the
    // arrow, not to `describe`. Indexing these would flood the index from every
    // test file in a repo.
    const n = names(
      `describe("suite", () => {\n  it("works", async () => {\n    const r = await go();\n    expect(r).toBe(1);\n  });\n});`,
    );
    expect(n).not.toContain("describe");
    expect(n).not.toContain("it");
  });

  it("does not index class constructors", () => {
    // Constructors are structurally forced to resemble one another — a DI
    // constructor is the same shape in every class — so indexing them floods
    // duplicate detection. Measured on ionic-framework: `constructor` alone
    // produced 80 of 214 duplicate findings and most of a 10-point composite
    // drop. They were not indexed before the method-shorthand pattern existed,
    // and they stay unindexed.
    const n = names(
      `class Widget {\n  constructor(private readonly store: Store) {\n    this.ready = false;\n    this.store = store;\n  }\n  render() {\n    const v = this.store.get();\n    return v ?? null;\n  }\n}`,
    );
    expect(n).not.toContain("constructor");
    expect(n).toContain("render");
  });

  it("does not index not-implemented stubs", () => {
    // A body whose only statement is a throw carries no reusable logic, but it
    // is byte-identical everywhere it appears, so indexing stubs manufactures
    // duplicate findings. Measured on NextChat: usage(), speech() and models()
    // are all `throw new Error("Method not implemented.")` across nine provider
    // clients, and dominated a 7.1-point composite drop.
    const n = names(
      `class Client {\n  speech(options: SpeechOptions): Promise<ArrayBuffer> {\n    throw new Error("Method not implemented.");\n  }\n  extractMessage(res: any) {\n    const parsed = normalize(res);\n    return parsed?.content?.text ?? "";\n  }\n}`,
    );
    expect(n).not.toContain("speech");
    expect(n).toContain("extractMessage");
  });

  it("still indexes a throw that is part of real logic", () => {
    const n = names(
      `function guard(url: string) {\n  const parsed = parse(url);\n  if (!parsed) throw new Error("bad url");\n  return parsed.host;\n}`,
    );
    expect(n).toContain("guard");
  });

  it("does not index interface members written without semicolons", () => {
    // prettier's `semi: false` is common, and without a terminating `;` the
    // return-type scan used to run past the declaration to the first `{` it
    // could find — often a real method many lines below — indexing a garbage
    // body made of comments and other declarations. Measured on TypeORM, whose
    // driver interfaces are written this way.
    const n = names(
      `export interface Driver {\n  connect(): Promise<void>\n\n  /** Performs connection. */\n  afterConnect(): Promise<void>\n}\n\nexport class Real {\n  doWork(n: number) {\n    const x = n * 2\n    return x + 1\n  }\n}`,
    );
    expect(n).not.toContain("connect");
    expect(n).not.toContain("afterConnect");
    expect(n).toEqual(["doWork"]);
  });

  it("still indexes a method whose body brace is on the next line", () => {
    const n = names(`class C {\n  doWork(n: number): number\n  {\n    const x = n * 2;\n    return x + 1;\n  }\n}`);
    expect(n).toContain("doWork");
  });

  it("does not index a call expression taking a function-keyword callback", () => {
    // The dangerous sibling of the arrow case. `([^)]*)` stops at the FIRST `)`,
    // which for `test('name', function (assert) {` is the CALLBACK's parameter
    // close, so the brace guard saw the callback's body and matched, indexing an
    // entry named after the CALLEE. Measured on a date library: this inflated the
    // index 2190 -> 5114, and because the duplicate scorer divides by function
    // count it moved the composite +9.5 in the OPTIMISTIC direction.
    const n = names(
      `test('format using constants', function (assert) {\n  const m = moment();\n  assert.equal(m.format('LTS'), 'x');\n});`,
    );
    expect(n).not.toContain("test");
    expect(n).toEqual([]);
  });

  it("does not index mocha-style registration helpers", () => {
    const n = names(
      `describe('suite', function () {\n  it('works', function (done) {\n    const r = go();\n    done(r);\n  });\n});`,
    );
    expect(n).not.toContain("describe");
    expect(n).not.toContain("it");
  });

  it("skips any function whose parameter list contains parentheses (known, pre-existing)", () => {
    // Both JS/TS patterns capture params with `[^)]*`, so a function-typed or
    // defaulted parameter containing `(` stops the capture early and the match
    // fails. This predates the callback guard and is unchanged by it; it is
    // recorded here so the limitation is visible rather than folklore.
    //
    // The direction is deliberate: the extractor errs toward missing a real
    // function rather than inventing a phantom one. Function count is the
    // denominator the duplicate scorer divides by, so a phantom inflates scores
    // optimistically while a miss does not.
    const method = names(
      `class Collection {\n  mapAll(fn: (x: number) => number, seed: number) {\n    const out = this.items.map(fn);\n    return out.concat(seed);\n  }\n}`,
    );
    expect(method).not.toContain("mapAll");

    // A plain parameter list is indexed normally, confirming the cause is the
    // parenthesis and not the method form itself.
    const plain = names(
      `class Collection {\n  mapAll(seed: number, factor: number) {\n    const out = this.items.map(String);\n    return out.concat(seed, factor);\n  }\n}`,
    );
    expect(plain).toContain("mapAll");
  });

  it("does not index a catch clause as a function", () => {
    const n = names(
      `function real() {\n  try {\n    risky();\n  } catch (err) {\n    report(err);\n  }\n  return 1;\n}`,
    );
    expect(n).toEqual(["real"]);
  });
});

describe("Go, Rust and Python extraction coverage", () => {
  const names = (content: string, language: SupportedLanguage, rel: string) =>
    extractFunctionsFromFile(mkFile(content, language, rel)).map((f) => f.name);

  it("indexes a Go generic function", () => {
    expect(
      names(
        `func Map[T any, U any](in []T, f func(T) U) []U {\n\tout := make([]U, 0)\n\tfor _, v := range in {\n\t\tout = append(out, f(v))\n\t}\n\treturn out\n}`,
        "go",
        "a.go",
      ),
    ).toContain("Map");
  });

  it("indexes a Go method with a receiver", () => {
    expect(
      names(
        `func (s *Server) Handle(w http.ResponseWriter) {\n\tlog.Print("x")\n\ts.count++\n\treturn\n}`,
        "go",
        "a.go",
      ),
    ).toContain("Handle");
  });

  it("indexes a Rust fn with a where clause", () => {
    expect(
      names(
        `fn convert<T>(v: T) -> String\nwhere\n    T: Display,\n{\n    let s = v.to_string();\n    s.trim().to_owned()\n}`,
        "rust",
        "a.rs",
      ),
    ).toContain("convert");
  });

  it("indexes a Rust fn with a where clause and NO return type", () => {
    // The `->` was doing the work of spanning the signature, so a where clause
    // with no return type left nothing to consume it.
    expect(
      names(
        `fn register<T>(v: T)\nwhere\n    T: Into<String>,\n{\n    let s = v.into();\n    store(s);\n}`,
        "rust",
        "a.rs",
      ),
    ).toContain("register");
  });

  it("indexes a plain Rust fn with a return type", () => {
    expect(
      names(`pub fn add(a: u32, b: u32) -> u32 {\n    let total = a + b;\n    total\n}`, "rust", "a.rs"),
    ).toContain("add");
  });

  it("indexes a Python method inside a class", () => {
    expect(
      names(
        `class Repo:\n    def find_user(self, uid):\n        row = db.get(uid)\n        return row or None\n`,
        "python",
        "a.py",
      ),
    ).toContain("find_user");
  });

  it("indexes an async Python function", () => {
    expect(
      names(`async def fetch_all(ids):\n    rows = await gather(ids)\n    return [r for r in rows if r]\n`, "python", "a.py"),
    ).toContain("fetch_all");
  });
});
