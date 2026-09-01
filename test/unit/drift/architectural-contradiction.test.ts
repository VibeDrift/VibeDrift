import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  architecturalContradiction,
  classifyDataAccessLabel,
  hasDataAccessPattern,
} from "../../../src/drift/architectural-contradiction.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("architectural-contradiction detector", () => {
  it("flags data-access drift when most files use repository pattern and one uses raw SQL", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(file(
        `src/services/svc${i}.ts`,
        `import { UserRepository } from "../repos/user";\nconst repo = new UserRepository();\nexport function getUser(id) { return repo.findById(id); }\n`,
      ));
    }
    files.push(file(
      "src/services/odd.ts",
      `import db from "../db";\nexport function getOrder(id) { return db.query("SELECT * FROM orders WHERE id = " + id); }\n`,
    ));
    const findings = architecturalContradiction.detect(mkCtx(files));
    // At least one finding about architectural consistency.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "architectural_consistency")).toBe(true);
  });

  it("no finding when all files agree on one architectural pattern", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(
        `src/services/svc${i}.ts`,
        `import { Repo } from "../repos/x";\nconst repo = new Repo();\nexport function get${i}(id) { return repo.findById(id); }\n`,
      ),
    );
    expect(architecturalContradiction.detect(mkCtx(files))).toHaveLength(0);
  });
});

describe("raw-SQL detection", () => {
  // The old regex was `(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|SET|\*)\b`,
  // which matched NONE of the four canonical statement forms: `\b` cannot hold
  // between `*` and a space, and FROM/SET never follow their verb immediately.
  // Raw SQL was therefore invisible to the whole data-access axis.
  const STATEMENTS: [string, string][] = [
    ["SELECT *", `const rows = await conn.exec("SELECT * FROM users");`],
    ["SELECT with column list", `const rows = await conn.exec("SELECT id, email FROM users WHERE id = $1");`],
    ["UPDATE ... SET", `await conn.exec("UPDATE users SET name = $1 WHERE id = $2");`],
    ["INSERT INTO", `await conn.exec("INSERT INTO users (id, email) VALUES ($1, $2)");`],
    ["DELETE FROM", `await conn.exec("DELETE FROM users WHERE id = $1");`],
  ];

  for (const [label, stmt] of STATEMENTS) {
    it(`classifies a body holding ${label} as raw SQL`, () => {
      expect(classifyDataAccessLabel(stmt, "src/services/orders.ts")).toBe("raw SQL queries");
    });
  }

  it("does not call an ordinary body raw SQL", () => {
    expect(classifyDataAccessLabel(`const x = selectOption(from);`, "src/ui/picker.ts")).toBeNull();
  });
});

describe("raw-SQL detection is anchored to the start of a string literal", () => {
  const RAW_SQL = "raw SQL queries";
  const isRawSql = (body: string, path = "src/services/orders.ts") =>
    hasDataAccessPattern(body, path, RAW_SQL);

  // The bare keyword-pair regex bridged `select` in one import's module path to
  // the `from` of the NEXT import, and matched prose comments. Measured on four
  // repos, most of its raw_sql file classifications were false.
  it("ignores import lines whose module path contains a keyword", () => {
    const body = [
      `import { select } from "./from";`,
      `import { renderSelect } from "./select.js";`,
      `import { relativeTime } from "./time.js";`,
      `export const x = select(1);`,
    ].join("\n");
    expect(isRawSql(body)).toBe(false);
    expect(classifyDataAccessLabel(body, "src/ui/picker.ts")).toBeNull();
  });

  it("ignores prose comments and sentence-case UI strings", () => {
    const body = [
      `// select the first item from the list, then update the cache set below`,
      `/* Delete the entry from the map once the insert into the queue lands. */`,
      `const hint = "Select an item from the list";`,
      `const msg = "Update your settings, then set a name";`,
      `export const y = 1;`,
    ].join("\n");
    expect(isRawSql(body)).toBe(false);
    expect(classifyDataAccessLabel(body, "src/ui/picker.ts")).toBeNull();
  });

  it("does not classify this repo's own report renderers as raw SQL", () => {
    // Both files were "raw SQL queries" under the unanchored regex, and the
    // push-order tie-break then let raw_sql win them outright.
    for (const rel of ["src/output/html.ts", "src/output/terminal.ts"]) {
      const content = readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
      expect(isRawSql(content, rel), rel).toBe(false);
      expect(classifyDataAccessLabel(content, rel), rel).not.toBe(RAW_SQL);
    }
  });

  const REAL_SQL: [string, string][] = [
    ["a plain double-quoted SELECT", `query("SELECT * FROM users")`],
    ["a template literal that opens on a newline", "db.query(`\n    SELECT id, name\n    FROM users\n    WHERE id = $1`)"],
    ["a Go raw-string query", "rows, err := db.Query(`SELECT * FROM users WHERE id = $1`)"],
    ["a Python triple-quoted query", `cursor.execute("""SELECT id FROM t""")`],
    ["a Python triple-quoted query that opens on a newline", `cursor.execute("""\n  SELECT id FROM users""")`],
    ["a lowercase query", `db.query("select * from users where id = $1")`],
    ["an f-string / template table", "db.query(`SELECT * FROM ${table} WHERE id = 1`)"],
    ["UPDATE ... SET", `db.exec("UPDATE users SET x = 1")`],
    ["INSERT INTO", `db.exec("INSERT INTO users (a) VALUES (1)")`],
    ["DELETE FROM", `db.exec("DELETE FROM users WHERE id = 1")`],
  ];
  for (const [label, body] of REAL_SQL) {
    it(`still classifies ${label} as raw SQL`, () => {
      expect(isRawSql(body)).toBe(true);
    });
  }
});

describe("data-access classifier / detector agreement", () => {
  it("gives the same label from the exported classifier and from the batch vote", () => {
    // The two entry points ranked a multi-signal body differently: the
    // classifier sorted by evidence count while the detector's vote took
    // whichever pattern detectDataAccess pushed first. Both now go through
    // detectFilePattern, so they cannot disagree.
    const body = [
      `export async function loadOrders(id: string) {`,
      `  const a = await db.query("SELECT * FROM orders WHERE id = $1", [id]);`,
      `  const b = await db.query("SELECT count(*) FROM lines WHERE order_id = $1", [id]);`,
      `  const c = await repo.findById(id);`,
      `  return { a, b, c };`,
      `}`,
    ].join("\n");
    const classifierLabel = classifyDataAccessLabel(body, "src/services/odd.ts");
    expect(classifierLabel).not.toBeNull();

    // Same body voted through the detector, with peers that all agree on
    // something else so the odd file lands in `deviatingFiles` with its label.
    const files: DriftFile[] = Array.from({ length: 5 }, (_, i) =>
      file(`src/services/svc${i}.ts`, `const users = await api.findMany({ where: { id } });\n`),
    );
    files.push(file("src/services/odd.ts", body));
    const findings = architecturalContradiction.detect(mkCtx(files));
    const dataAccess = findings.find((f) => f.subCategory === "data_access");
    expect(dataAccess).toBeDefined();
    const odd = dataAccess!.deviatingFiles.find((d) => d.path === "src/services/odd.ts");
    expect(odd).toBeDefined();
    expect(odd!.detectedPattern).toBe(classifierLabel);
  });
});

describe("intent-hint axis binding", () => {
  function withHint(files: DriftFile[]): DriftContext {
    return {
      ...mkCtx(files),
      intentHints: [{
        category: "architectural_consistency",
        pattern: "repository",
        label: "repository pattern",
        source: "CLAUDE.md",
        line: 12,
        text: "- Use the repository pattern",
        confidence: 0.9,
      }],
    };
  }

  it("seeds ONLY the data-access axis from a data-access declaration", () => {
    // A seeded vote skips the 70% dominance gate, so seeding all four axes
    // with one hint forced error_handling / configuration / dependency_injection
    // findings out of directories the raw vote would have left alone.
    // These files are unanimous on config (env_direct) and error handling
    // (wrap_with_context) — only data access is mixed.
    const files: DriftFile[] = Array.from({ length: 4 }, (_, i) =>
      file(
        `src/services/svc${i}.ts`,
        `const url = process.env.DB_URL;\n` +
        `export function get${i}(id) {\n` +
        `  if (!id) throw new ValidationError("bad id");\n` +
        `  return repo.findById(id);\n` +
        `}\n`,
      ),
    );
    files.push(file(
      "src/services/odd.ts",
      `const url = process.env.DB_URL;\n` +
      `export function getOrder(id) {\n` +
      `  if (!id) throw new ValidationError("bad id");\n` +
      `  return conn.exec("SELECT * FROM orders WHERE id = " + id);\n` +
      `}\n`,
    ));

    const seeded = architecturalContradiction.detect(withHint(files));
    const axes = new Set(seeded.map((f) => f.subCategory));
    expect(axes.has("error_handling")).toBe(false);
    expect(axes.has("configuration")).toBe(false);
    expect(axes.has("dependency_injection")).toBe(false);
  });
});

describe("dependency-injection axis", () => {
  function langFile(path: string, language: string, content: string): DriftFile {
    return { relativePath: path, language, content, lineCount: content.split("\n").length };
  }

  it("does not vote Python/Rust files onto an axis it cannot classify", () => {
    // detectDIPattern only recognizes Go and JS/TS constructor injection, so
    // Python and Rust files could only ever emit the `no_di` sentinel. Voting
    // them built a phantom peer group whose only member with a real
    // classification then read as the deviator.
    const files: DriftFile[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        langFile(`src/app/svc${i}.py`, "python", `import os\nCONF = os.environ["X"]\ndef get_${i}(id):\n    raise ValueError(id)\n`),
      ),
      langFile(
        "src/app/wired.ts",
        "typescript",
        `const conf = process.env.X;\nexport class Svc {\n  constructor(private store: Store) {}\n}\n`,
      ),
    ];
    const di = architecturalContradiction.detect(mkCtx(files)).filter(
      (f) => f.subCategory === "dependency_injection",
    );
    expect(di).toHaveLength(0);
  });
});
