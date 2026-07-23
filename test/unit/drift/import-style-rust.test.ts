import { describe, it, expect } from "vitest";
import { rustImportClassifier } from "../../../src/drift/import-style/rust.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { AxisClassification } from "../../../src/drift/import-style/types.js";
import type { DriftFile } from "../../../src/drift/types.js";

const rs = (path: string, src: string) => fileWithTree(path, src, "rust");
function treeless(path: string, content: string): DriftFile {
  return { relativePath: path, language: "rust", content, lineCount: content.split("\n").length };
}
const axis = (out: AxisClassification[], a: string) => out.filter((c) => c.axis === a);

describe("Rust glob imports (rust_glob) — AST path", () => {
  it("glob: a wildcard use", async () => {
    const f = await rs("src/main.rs", `use std::collections::HashMap;\nuse crate::prelude::*;\n`);
    const out = axis(rustImportClassifier.classify(f), "rust_glob");
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("glob");
  });

  it("explicit: ≥2 uses, none glob", async () => {
    const f = await rs("src/main.rs", `use std::collections::HashMap;\nuse serde::Deserialize;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("explicit");
  });

  it("not decidable: a single explicit use", async () => {
    const f = await rs("src/main.rs", `use std::collections::HashMap;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")).toEqual([]);
  });

  it("decidable on a single glob use", async () => {
    const f = await rs("src/main.rs", `use crate::prelude::*;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("glob");
  });
});

describe("Rust glob imports — regex fallback (tree-less)", () => {
  it("glob", () => {
    const f = treeless("src/main.rs", `use std::collections::HashMap;\nuse crate::prelude::*;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("glob");
  });

  it("explicit", () => {
    const f = treeless("src/main.rs", `use std::collections::HashMap;\nuse serde::Deserialize;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("explicit");
  });
});

describe("Rust intra-crate use path (rust_use_path)", () => {
  it("crate: ≥2 absolute intra-crate uses", async () => {
    const f = await rs("src/a.rs", `use crate::models::User;\nuse crate::db::Session;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")[0]?.pattern).toBe("crate");
  });

  it("relative: ≥2 super/self uses", async () => {
    const f = await rs("src/a.rs", `use super::models::User;\nuse self::helpers::x;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")[0]?.pattern).toBe("relative");
  });

  it("not decidable: only external-crate uses", async () => {
    const f = await rs("src/a.rs", `use std::collections::HashMap;\nuse serde::Deserialize;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")).toEqual([]);
  });

  it("regex fallback: crate", () => {
    const f = treeless("src/a.rs", `use crate::models::User;\nuse crate::db::Session;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")[0]?.pattern).toBe("crate");
  });
});

describe("Rust use grouping (rust_grouping)", () => {
  it("grouped: std and internal separated by a blank line", async () => {
    const f = await rs("src/a.rs", `use std::collections::HashMap;\n\nuse crate::models::User;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_grouping")[0]?.pattern).toBe("grouped");
  });

  it("flat: ≥2 origins, no blank line", async () => {
    const f = await rs("src/a.rs", `use std::collections::HashMap;\nuse crate::models::User;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_grouping")[0]?.pattern).toBe("flat");
  });

  it("not decidable: a single origin (std only)", async () => {
    const f = await rs("src/a.rs", `use std::collections::HashMap;\nuse std::fmt::Debug;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_grouping")).toEqual([]);
  });

  it("regex fallback: grouped", () => {
    const f = treeless("src/a.rs", `use std::collections::HashMap;\n\nuse serde::Deserialize;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_grouping")[0]?.pattern).toBe("grouped");
  });
});


describe("Rust relative-glob idioms are excluded (precision)", () => {
  it("rust_glob: idiomatic `use super::*;` (test re-import) is not counted as a glob", () => {
    const f = treeless("src/a.rs", `use crate::foo::Bar;\nuse crate::baz::Qux;\nuse super::*;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("explicit");
  });

  it("rust_glob: `use self::Enum::*;` (enum-variant scoping) is not counted as a glob", () => {
    const f = treeless("src/a.rs", `use crate::foo::Bar;\nuse crate::baz::Qux;\nuse self::Color::*;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("explicit");
  });

  it("rust_glob: a non-relative glob (crate::/external ::*) still flags as glob", () => {
    const f = treeless("src/a.rs", `use crate::prelude::*;\nuse std::fmt::Debug;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_glob")[0]?.pattern).toBe("glob");
  });

  it("rust_use_path: a `use super::*;` glob does not count as a relative use", () => {
    // The glob is excluded, leaving <2 intra-crate uses → not decidable.
    const f = treeless("src/a.rs", `use crate::foo::Bar;\nuse super::*;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")).toEqual([]);
  });

  it("rust_use_path: a non-glob `use super::foo;` still counts as relative", () => {
    const f = treeless("src/a.rs", `use crate::foo::Bar;\nuse super::helper;\n`);
    expect(axis(rustImportClassifier.classify(f), "rust_use_path")[0]?.pattern).toBe("crate");
  });
});
