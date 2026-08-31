import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../scripts/sync-plugin-version.mjs");

let root: string;

function writeFixture(opts: {
  pkgVersion?: string;
  pluginVersion?: string;
  skills?: string[];
  marketplace?: string | null;
  pluginRaw?: string;
}): void {
  const {
    pkgVersion = "1.2.3",
    pluginVersion = "1.2.3",
    skills = ["./skills/setup"],
    marketplace = '{"name":"vibedrift","plugins":[]}',
    pluginRaw,
  } = opts;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    pluginRaw ??
      `{\n  "name": "vibedrift",\n  "version": "${pluginVersion}",\n  "skills": ${JSON.stringify(skills)}\n}\n`,
  );
  if (marketplace !== null) {
    fs.writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), marketplace);
  }
  for (const s of skills) {
    const dir = path.join(root, s);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n");
  }
}

function run(args: string[] = []): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, SYNC_PLUGIN_ROOT: root },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string };
    return { status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function pluginJson(): string {
  return fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-plugin-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("sync-plugin-version", () => {
  it("rewrites plugin.json to the package.json version, preserving formatting", () => {
    writeFixture({ pkgVersion: "2.0.0", pluginVersion: "1.2.3" });
    const before = pluginJson();
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toContain("1.2.3 -> 2.0.0");
    expect(pluginJson()).toBe(before.replace('"1.2.3"', '"2.0.0"'));
  });

  it("is a no-op when versions already match, and idempotent on repeat", () => {
    writeFixture({});
    expect(run().status).toBe(0);
    const after = pluginJson();
    expect(run().status).toBe(0);
    expect(pluginJson()).toBe(after);
  });

  it("--check passes on matching versions and valid manifests", () => {
    writeFixture({});
    const { status, out } = run(["--check"]);
    expect(status).toBe(0);
    expect(out).toContain("OK");
  });

  it("--check fails on version drift without writing", () => {
    writeFixture({ pkgVersion: "2.0.0", pluginVersion: "1.2.3" });
    const before = pluginJson();
    const { status, out } = run(["--check"]);
    expect(status).toBe(1);
    expect(out).toContain("version drift");
    expect(pluginJson()).toBe(before);
  });

  it("--check fails when a declared skill path has no SKILL.md", () => {
    writeFixture({});
    fs.rmSync(path.join(root, "skills", "setup", "SKILL.md"));
    const { status, out } = run(["--check"]);
    expect(status).toBe(1);
    expect(out).toContain("SKILL.md");
  });

  it("--check fails when marketplace.json is missing or invalid", () => {
    writeFixture({ marketplace: "{not json" });
    expect(run(["--check"]).status).toBe(1);
    fs.rmSync(path.join(root, ".claude-plugin", "marketplace.json"));
    expect(run(["--check"]).status).toBe(1);
  });

  it("fails when plugin.json is not valid JSON", () => {
    writeFixture({ pluginRaw: '{\n  "version": "1.2.3",\n  broken' });
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain("not valid JSON");
  });

  it("fails loudly when the first version-shaped line is not the top-level key", () => {
    // A nested "version" line above the top-level one would make the regex
    // target the wrong line; the JSON.parse cross-check must refuse.
    writeFixture({
      pluginRaw:
        '{\n  "mcpServers": {\n    "x": {\n      "version": "9.9.9"\n    }\n  },\n  "version": "1.2.3",\n  "skills": []\n}\n',
    });
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain("not the top-level version key");
  });

  it("fails when package.json has no version", () => {
    writeFixture({});
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain('no "version" field');
  });

  it("fails when plugin.json has no version line", () => {
    writeFixture({ pluginRaw: '{ "name": "vibedrift" }\n' });
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain('no "version" field found');
  });
});
