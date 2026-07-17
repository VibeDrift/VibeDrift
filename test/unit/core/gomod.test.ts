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

  it("parses nested modules with their dir, module path, and requires, sorted by dir", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n`);
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(
      join(dir, "tools", "go.mod"),
      `module example.com/app/tools\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n`,
    );
    await mkdir(join(dir, "services", "auth"), { recursive: true });
    await writeFile(
      join(dir, "services", "auth", "go.mod"),
      `module example.com/auth\n\nrequire github.com/golang-jwt/jwt/v5 v5.2.0\n`,
    );

    const mod = await loadGoMod(dir);
    expect(mod?.hasNestedModule).toBe(true);
    expect(mod?.nestedModules).toEqual([
      {
        dir: "services/auth",
        module: "example.com/auth",
        require: [{ path: "github.com/golang-jwt/jwt/v5", version: "v5.2.0" }],
      },
      {
        dir: "tools",
        module: "example.com/app/tools",
        require: [{ path: "github.com/spf13/cobra", version: "v1.8.0" }],
      },
    ]);
  });

  it("skips vendored dirs entirely; an unparseable nested go.mod becomes an opaqueModuleDir", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n`);
    await mkdir(join(dir, "vendor", "dep"), { recursive: true });
    await writeFile(join(dir, "vendor", "dep", "go.mod"), `module example.com/vendored\n`);
    await mkdir(join(dir, "broken"), { recursive: true });
    await writeFile(join(dir, "broken", "go.mod"), `// no module line\n`);

    const mod = await loadGoMod(dir);
    // vendored go.mod is invisible; the broken one keeps the (over-detecting,
    // safe) cross-file disable guard and is recorded as an opaque dir so the
    // dependency analyzer excludes its files rather than blaming root.
    expect(mod?.nestedModules).toBeUndefined();
    expect(mod?.opaqueModuleDirs).toEqual(["broken"]);
    expect(mod?.hasNestedModule).toBe(true);
  });

  it("marks `// indirect` requires so the analyzer can exclude them from phantom detection", async () => {
    await writeFile(
      join(dir, "go.mod"),
      `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gorilla/mux v1.8.0\n\tgithub.com/ajg/form v1.5.1 // indirect\n)\n`,
    );
    const mod = await loadGoMod(dir);
    expect(mod?.require).toEqual([
      { path: "github.com/gorilla/mux", version: "v1.8.0" },
      { path: "github.com/ajg/form", version: "v1.5.1", indirect: true },
    ]);
  });

  it("marks a single-line `// indirect` require", async () => {
    await writeFile(
      join(dir, "go.mod"),
      `module example.com/app\n\nrequire github.com/ajg/form v1.5.1 // indirect\n`,
    );
    const mod = await loadGoMod(dir);
    expect(mod?.require).toEqual([
      { path: "github.com/ajg/form", version: "v1.5.1", indirect: true },
    ]);
  });

  it("a vendored go.mod alone trips nothing", async () => {
    await writeFile(join(dir, "go.mod"), `module example.com/app\n`);
    await mkdir(join(dir, "vendor", "dep"), { recursive: true });
    await writeFile(join(dir, "vendor", "dep", "go.mod"), `module example.com/vendored\n`);

    const mod = await loadGoMod(dir);
    expect(mod?.nestedModules).toBeUndefined();
    expect(mod?.hasNestedModule).toBeFalsy();
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
