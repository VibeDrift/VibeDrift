import { spawn, type SpawnOptions } from "child_process";
import chalk from "chalk";

const PACKAGE_NAME = "@vibedrift/cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

/**
 * Spawn config for a global npm install, routed through the shell.
 *
 * The bug this fixes: on Windows `npm` is `npm.cmd`, and Node refuses to spawn
 * a `.cmd` file without a shell (`spawn npm ENOENT`, hardened further after the
 * .cmd-spawn CVE). MINGW64 / Git Bash still reports `process.platform === "win32"`,
 * so there is no POSIX escape hatch — the single cross-platform fix is to let the
 * shell (cmd.exe on Windows, /bin/sh on POSIX) resolve `npm` from PATH/PATHEXT.
 */
export function npmGlobalInstallSpawn(pkgSpec: string): {
  command: string;
  args: string[];
  options: SpawnOptions & { shell: true; stdio: "inherit" };
} {
  return {
    command: "npm",
    args: ["i", "-g", pkgSpec],
    options: { stdio: "inherit", shell: true },
  };
}

/**
 * The registry `version` is trusted, but we interpolate it into a string that
 * the shell parses, so reject anything that isn't a plain version token before
 * it ever reaches the shell.
 */
export function isSafeVersionToken(v: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(v);
}

function semverGreater(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function runUpdate(currentVersion: string): Promise<void> {
  console.log(chalk.dim("Checking for updates..."));

  let latest: string;
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`registry returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { version?: string };
    if (!data.version) {
      throw new Error("registry response missing version field");
    }
    latest = data.version;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to check for updates: ${message}`));
    console.error(chalk.dim(`Try manually: npm i -g ${PACKAGE_NAME}@latest`));
    process.exit(1);
  }

  if (currentVersion === latest) {
    console.log(
      chalk.green(`✓ Already on the latest version (${currentVersion}).`),
    );
    return;
  }

  if (!semverGreater(latest, currentVersion)) {
    console.log(
      chalk.yellow(
        `Local version (${currentVersion}) is ahead of the registry (${latest}). Nothing to do.`,
      ),
    );
    return;
  }

  if (!isSafeVersionToken(latest)) {
    console.error(
      chalk.red(`Registry returned an unexpected version string ("${latest}").`),
    );
    console.error(chalk.dim(`Install manually: npm i -g ${PACKAGE_NAME}@latest`));
    process.exit(1);
  }

  console.log(
    chalk.bold(
      `Updating ${PACKAGE_NAME}: ${chalk.dim(currentVersion)} → ${chalk.yellow(latest)}`,
    ),
  );
  console.log(chalk.dim(`Running: npm i -g ${PACKAGE_NAME}@${latest}\n`));

  await new Promise<void>((resolve, reject) => {
    const { command, args, options } = npmGlobalInstallSpawn(
      `${PACKAGE_NAME}@${latest}`,
    );
    const child = spawn(command, args, options);
    child.on("error", (err) => {
      reject(err);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm exited with code ${code}`));
      }
    });
  })
    .then(() => {
      console.log(chalk.green(`\n✓ Updated to ${latest}.`));
      console.log(chalk.dim("Run `vibedrift --version` to verify."));
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nUpdate failed: ${message}`));
      console.error(chalk.dim("\nManual install commands by package manager:"));
      console.error(chalk.dim(`  npm:  npm i -g ${PACKAGE_NAME}@latest`));
      console.error(chalk.dim(`  pnpm: pnpm add -g ${PACKAGE_NAME}@latest`));
      console.error(chalk.dim(`  bun:  bun add -g ${PACKAGE_NAME}@latest`));
      console.error(chalk.dim(`  yarn: yarn global add ${PACKAGE_NAME}@latest`));
      process.exit(1);
    });
}
