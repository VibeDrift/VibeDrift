import { describe, it, expect } from "vitest";
import { analyzeTaintFlows } from "../../../src/codedna/taint-analysis.js";
import { extractAllFunctions } from "../../../src/codedna/function-extractor.js";
import type { ExtractedFunction } from "../../../src/codedna/types.js";
import type { SourceFile, SupportedLanguage } from "../../../src/core/types.js";

function mkFn(partial: Partial<ExtractedFunction>): ExtractedFunction {
  const params = partial.params ?? [];
  return {
    name: partial.name ?? "fn",
    file: partial.file ?? "src/a.ts",
    relativePath: partial.relativePath ?? partial.file ?? "src/a.ts",
    line: partial.line ?? 1,
    language: partial.language ?? "typescript",
    params,
    paramNames: partial.paramNames ?? params,
    paramCount: partial.paramCount ?? params.length,
    rawBody: partial.rawBody ?? "",
    declarationCode: partial.declarationCode ?? "",
    domainCategory: partial.domainCategory ?? "handlers",
    bodyTokens: partial.bodyTokens ?? [],
    bodyTokenCount: partial.bodyTokenCount ?? 0,
    bodyHash: partial.bodyHash ?? 0,
  };
}

const body = (...lines: string[]) => lines.join("\n");
const sinkTypes = (fn: ExtractedFunction) => analyzeTaintFlows([fn]).map((f) => f.sink.type);

const file = (
  relativePath: string,
  content: string,
  language: SupportedLanguage,
): SourceFile => ({
  path: `/repo/${relativePath}`,
  relativePath,
  language,
  content,
  lineCount: content.split("\n").length,
});

describe("sanitizer anchoring", () => {
  // A false sanitizer is worse than a false sink: it silences a REAL flow for
  // the rest of the function. Unanchored, `int\s*\(` was satisfied by `print(`,
  // `Number\s*\(` by `PhoneNumber(`, and `escape\s*\(` by `unescape(` — the very
  // call that undoes escaping.
  it("print() does not sanitize (int() must not match the tail of an identifier)", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "print(id);",
          "const rows = db.query(`SELECT * FROM users WHERE id = ${id}`);",
        ),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
  });

  it("logEndpoint() does not sanitize", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "logEndpoint(id);",
          "const rows = db.query(`SELECT * FROM users WHERE id = ${id}`);",
        ),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
  });

  it("PhoneNumber() does not sanitize", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "const phone = PhoneNumber(id);",
          "const rows = db.query(`SELECT * FROM users WHERE id = ${id}`);",
        ),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
  });

  it("unescape() does not sanitize an XSS flow", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const q = req.query.q;",
          "const back = unescape(q);",
          "el.innerHTML = q;",
        ),
      }),
    );
    expect(flows).toContain("HTML injection");
  });

  it("the genuine sanitizers still fire", () => {
    expect(
      sinkTypes(
        mkFn({
          rawBody: body(
            "const id = req.params.id;",
            "const n = parseInt(id, 10);",
            "const rows = db.query(`SELECT * FROM users WHERE id = ${n}`);",
          ),
        }),
      ),
    ).toHaveLength(0);

    expect(
      sinkTypes(
        mkFn({
          rawBody: body(
            "const q = req.query.q;",
            "const clean = escape(q);",
            "el.innerHTML = clean;",
          ),
        }),
      ),
    ).toHaveLength(0);
  });
});

describe("sink anchoring", () => {
  it("RegExp .exec() is not a command injection", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "const m = SLUG_RE.exec(id);",
          "return m;",
        ),
      }),
    );
    expect(flows).not.toContain("command execution");
  });

  it("child_process.exec IS still a command injection", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body("const cmd = req.body.cmd;", "child_process.exec(cmd);"),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.join(" ")).toMatch(/child process|command execution/);
  });

  it("a bare exec() call IS still a command injection", () => {
    const flows = sinkTypes(
      mkFn({ rawBody: body("const cmd = req.body.cmd;", "exec(cmd);") }),
    );
    expect(flows).toContain("command execution");
  });

  // The bare anchor must not un-detect a dotted call whose receiver is a known
  // alias for the owning module or global.
  it("cp.exec(cmd) on a child_process alias IS a command injection", () => {
    const flows = sinkTypes(
      mkFn({ rawBody: body("const cmd = req.body.cmd;", "cp.exec(cmd);") }),
    );
    expect(flows).toContain("command execution");
  });

  it("child_process.exec(cmd) is reported as ONE command-injection sink, not two", () => {
    const flows = sinkTypes(
      mkFn({ rawBody: body("const cmd = req.body.cmd;", "child_process.exec(cmd);") }),
    );
    expect(flows).toEqual(["command execution"]);
  });

  it("window.fetch(url) IS an outbound fetch (ssrf)", () => {
    const flows = sinkTypes(
      mkFn({ rawBody: body("const url = req.query.url;", "const r = await window.fetch(url);") }),
    );
    expect(flows).toContain("outbound HTTP fetch");
  });

  it("an exec on somebody's own object (not a module alias) is still not a sink", () => {
    const flows = sinkTypes(
      mkFn({ rawBody: body("const id = req.params.id;", "const m = this.sh.exec(id);") }),
    );
    expect(flows).not.toContain("command execution");
  });

  it("parseFunction() is not a dynamic-function sink, but `new Function(` is", () => {
    expect(
      sinkTypes(
        mkFn({ rawBody: body("const src = req.body.src;", "const ast = parseFunction(src);") }),
      ),
    ).not.toContain("dynamic function");

    expect(
      sinkTypes(
        mkFn({ rawBody: body("const src = req.body.src;", "const f = new Function(src);") }),
      ),
    ).toContain("dynamic function");
  });

  it("reopen() is not a path-traversal sink, but a bare open() is", () => {
    expect(
      sinkTypes(mkFn({ rawBody: body("const p = req.query.p;", "reopen(p);") })),
    ).not.toContain("file open");

    expect(
      sinkTypes(mkFn({ rawBody: body("const p = req.query.p;", "open(p);") })),
    ).toContain("file open");
  });
});

describe("tainted-variable mentions are whole identifiers", () => {
  it("does not flag a sink line that merely CONTAINS the tainted name as a substring", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          'const rows = db.query("SELECT * FROM invalid_rows");',
          "return rows;",
        ),
      }),
    );
    expect(flows).toHaveLength(0);
  });

  it("still flags the sink line that really uses the tainted variable", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "const rows = db.query(`SELECT * FROM rows WHERE id = ${id}`);",
        ),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
  });

  it("a sanitizer on an unrelated identifier does not clear the taint", () => {
    const flows = sinkTypes(
      mkFn({
        rawBody: body(
          "const id = req.params.id;",
          "const width = parseInt(gridWidth, 10);",
          "const rows = db.query(`SELECT * FROM rows WHERE id = ${id}`);",
        ),
      }),
    );
    expect(flows.length).toBeGreaterThan(0);
  });
});

describe("one-hop interprocedural taint across languages", () => {
  // Phase 2 keyed taint on `ExtractedFunction.params`, which is the raw text
  // between the commas — "userId: string" in TypeScript, "userId string" in Go,
  // "userId: u32" in Rust. Those never match an identifier in the body, so the
  // handler -> service flow was found in plain JavaScript and NOWHERE else.
  const tsSource = [
    "export function handler(req: Request, res: Response) {",
    "  const id = req.params.id;",
    "  const rows = service(id);",
    "  return rows;",
    "}",
    "export function service(userId: string) {",
    "  const out = db.query(`SELECT * FROM users WHERE id = ${userId}`);",
    "  return out;",
    "}",
  ].join("\n");

  const jsSource = tsSource
    .replace("(req: Request, res: Response)", "(req, res)")
    .replace("(userId: string)", "(userId)");

  function oneHopFlows(source: string, language: SupportedLanguage, path: string) {
    const fns = extractAllFunctions([file(path, source, language)]);
    return analyzeTaintFlows(fns).filter((f) => f.sink.type.includes("service()"));
  }

  it("finds the same handler -> service flow in TypeScript and in JavaScript", () => {
    const js = oneHopFlows(jsSource, "javascript", "src/handlers/a.js");
    const ts = oneHopFlows(tsSource, "typescript", "src/handlers/a.ts");
    expect(js.length).toBeGreaterThan(0);
    expect(ts.length).toBe(js.length);
  });
});
