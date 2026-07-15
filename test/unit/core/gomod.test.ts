import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadGoMod } from "../../../src/core/discovery.js";

/**
 * loadGoMod exposes two safety flags used to DISABLE Go cross-file package
 * resolution wholesale: `hasReplace` (a replace directive remaps an import
 * path to another dir, breaking root-prefix math) and `hasNestedModule` (a
 * second module under the root breaks the prefix math too). Both are
 * never-false-bless guards for the cross-file auth feature.
 */
describe("loadGoMod replace + nested-module detection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-gomod-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses the module path and leaves the guards unset for a plain go.mod", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n\ngo 1.22\n`);
    const mod = await loadGoMod(dir);
    expect(mod?.module).toBe("example.com/app");
    expect(mod?.hasReplace).toBeFalsy();
    expect(mod?.hasNestedModule).toBeFalsy();
  });

  it("detects a single-line replace directive", async () => {
    await writeFile(
      join(dir, "go.mod"),
      `module example.com/app\n\ngo 1.22\n\nreplace example.com/x => ./local/x\n`,
    );
    expect((await loadGoMod(dir))?.hasReplace).toBe(true);
  });

  it("detects a block-form replace directive", async () => {
    await writeFile(
      join(dir, "go.mod"),
      `module example.com/app\n\ngo 1.22\n\nreplace (\n\texample.com/x => ./local/x\n)\n`,
    );
    expect((await loadGoMod(dir))?.hasReplace).toBe(true);
  });

  it("detects a nested go.mod under the scan root", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n`);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "go.mod"), `module example.com/app/sub\n`);
    expect((await loadGoMod(dir))?.hasNestedModule).toBe(true);
  });

  it("does not treat the root go.mod itself as a nested module", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n`);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "handler.go"), `package sub\n`);
    expect((await loadGoMod(dir))?.hasNestedModule).toBeFalsy();
  });

  it("returns null when there is no go.mod", async () => {
    expect(await loadGoMod(dir)).toBeNull();
  });
});
