#!/usr/bin/env node
/* global process, Buffer, URL, console */
/**
 * vibedrift-tools — a thin CLI over @vibedrift/cli/tools for the Agent Skill.
 *
 * This is the channel-neutral path: it imports the same five tool functions the
 * MCP server exposes and runs ONE of them, printing JSON. It exists so an agent
 * can prevent drift "in the loop" by running a command, with no MCP server and no
 * editor integration — the skill drives the procedure, this runner does the work.
 *
 * Usage:
 *   vibedrift-tools intent          --root <dir>
 *   vibedrift-tools dominant        --root <dir> --dimension <name>
 *   vibedrift-tools check-file      --root <dir> --file <path>
 *   vibedrift-tools find-similar    --root <dir> [--deep]   (body on stdin)
 *   vibedrift-tools validate-change --root <dir> --file <path> [--deep]  (body on stdin)
 *
 * The function body for find-similar / validate-change is read from STDIN, so
 * multi-line source pipes in cleanly:
 *   cat new-func.ts | vibedrift-tools validate-change --root . --file src/x.ts
 */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { root: process.cwd(), deep: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--deep") flags.deep = true;
    else if (a === "--root") flags.root = rest[++i];
    else if (a === "--file") flags.file = rest[++i];
    else if (a === "--dimension") flags.dimension = rest[++i];
    else if (a === "--body") flags.body = rest[++i];
  }
  return { command, flags };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadTools() {
  // Prefer the installed package; fall back to the in-repo build for development.
  try {
    return await import("@vibedrift/cli/tools");
  } catch {
    return await import(new URL("../../../dist/tools-core/index.js", import.meta.url));
  }
}

function fail(msg) {
  console.error(`vibedrift-tools: ${msg}`);
  process.exit(2);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command) fail("missing command (intent | dominant | check-file | find-similar | validate-change)");

  const tools = await loadTools();
  let result;

  switch (command) {
    case "intent":
      result = await tools.getIntentHints({ rootDir: flags.root });
      break;
    case "dominant":
      if (!flags.dimension) fail("dominant needs --dimension");
      result = await tools.getDominantPattern({ rootDir: flags.root, dimension: flags.dimension });
      break;
    case "check-file": {
      if (!flags.file) fail("check-file needs --file");
      const out = await tools.checkFileDrift({ rootDir: flags.root, filePath: flags.file });
      result = await tools.finalizeResult(out, { nudge: true });
      break;
    }
    case "find-similar": {
      const body = flags.body ?? (await readStdin());
      if (!body.trim()) fail("find-similar needs a function body on stdin or via --body");
      const out = await tools.findSimilarFunction({ rootDir: flags.root, body, deep: flags.deep });
      result = await tools.finalizeResult(out, { nudge: false });
      break;
    }
    case "validate-change": {
      if (!flags.file) fail("validate-change needs --file");
      const body = flags.body ?? (await readStdin());
      if (!body.trim()) fail("validate-change needs a function body on stdin or via --body");
      const out = await tools.validateChange({ rootDir: flags.root, targetPath: flags.file, body, deep: flags.deep });
      result = await tools.finalizeResult(out, { nudge: true });
      break;
    }
    default:
      fail(`unknown command "${command}"`);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // Surface the nudge on stderr too, so a human watching the agent sees the offer
  // even if the agent only forwards stdout.
  if (result && result.nudge) {
    console.error(`\n[vibedrift] ${result.nudge.message}`);
  }
}

main().catch((err) => {
  console.error(`vibedrift-tools: ${err?.stack ?? err}`);
  process.exit(1);
});
