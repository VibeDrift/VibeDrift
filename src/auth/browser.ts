import { spawn } from "child_process";

/**
 * Cross-platform browser opener.
 *
 * Returns true if the open command was launched successfully (we cannot
 * tell if the user actually saw the page). Returns false if no opener
 * is available — callers should fall back to printing the URL.
 *
 * Honors the BROWSER environment variable when set (Linux/CI convention).
 * Refuses to open in non-interactive environments (CI=true and no TTY)
 * to avoid spawning hidden processes.
 */
export function openInBrowser(url: string): boolean {
  if (!isInteractive()) return false;

  const env = process.env.BROWSER;
  if (env && env.length > 0 && env !== "none") {
    return spawnDetached(env, [url]);
  }

  switch (process.platform) {
    case "darwin":
      return spawnDetached("open", [url]);
    case "win32":
      return spawnDetached("cmd", ["/c", "start", "", url]);
    default:
      return spawnDetached("xdg-open", [url]);
  }
}

function isInteractive(): boolean {
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  if (process.env.VIBEDRIFT_NO_BROWSER === "1") return false;
  return process.stdout.isTTY ?? false;
}

function spawnDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", () => {
      // Swallow — caller already returned true and printed a fallback URL.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
