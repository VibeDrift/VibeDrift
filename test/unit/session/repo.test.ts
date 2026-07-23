import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoRoot, repoIdentity, defaultSessionsDir } from "@/session/repo";
import { projectHash } from "@/core/baseline";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

describe("resolveRepoRoot", () => {
  it("walks up to the nearest .git ancestor", () => {
    const a = tmp("vd-repo-");
    mkdirSync(join(a, ".git"));
    mkdirSync(join(a, "b", "c"), { recursive: true });
    expect(resolveRepoRoot(join(a, "b", "c"))).toBe(a);
  });

  it("prefers the nearest .git when nested", () => {
    const a = tmp("vd-nested-");
    mkdirSync(join(a, ".git"));
    mkdirSync(join(a, "sub", ".git"), { recursive: true });
    mkdirSync(join(a, "sub", "deep"), { recursive: true });
    expect(resolveRepoRoot(join(a, "sub", "deep"))).toBe(join(a, "sub"));
  });

  it("falls back to the input dir when no .git exists", () => {
    const d = tmp("vd-norepo-");
    expect(resolveRepoRoot(d)).toBe(d);
  });
});

describe("repoIdentity", () => {
  it("hash matches core projectHash of the resolved root", () => {
    const d = tmp("vd-id-");
    const id = repoIdentity(d);
    expect(id.rootDir).toBe(d);
    expect(id.projectHash).toBe(projectHash(d));
  });
});

describe("defaultSessionsDir", () => {
  it("lives under ~/.vibedrift/sessions", () => {
    expect(defaultSessionsDir().endsWith(join(".vibedrift", "sessions"))).toBe(true);
  });
});
