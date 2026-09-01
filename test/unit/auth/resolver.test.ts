import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * resolveToken/resolveApiUrl read env vars live and go through
 * src/auth/config.ts's readConfig(), which resolves its path from
 * vibedriftHome() at import time. Redirect VIBEDRIFT_HOME to a fresh
 * temp dir and vi.resetModules() + dynamic-import per test, same
 * pattern as test/unit/auth/config.test.ts.
 *
 * Note: another agent may be adding https:// validation to
 * resolveApiUrl — every URL fixture here already uses https:// so the
 * precedence assertions hold either way.
 */

describe("auth/resolver", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origToken: string | undefined;
  let origApiUrl: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "vd-auth-resolver-"));
    origHome = process.env.VIBEDRIFT_HOME;
    origToken = process.env.VIBEDRIFT_TOKEN;
    origApiUrl = process.env.VIBEDRIFT_API_URL;
    process.env.VIBEDRIFT_HOME = tmpHome;
    delete process.env.VIBEDRIFT_TOKEN;
    delete process.env.VIBEDRIFT_API_URL;
    vi.resetModules();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.VIBEDRIFT_HOME = origHome;
    else delete process.env.VIBEDRIFT_HOME;
    if (origToken !== undefined) process.env.VIBEDRIFT_TOKEN = origToken;
    else delete process.env.VIBEDRIFT_TOKEN;
    if (origApiUrl !== undefined) process.env.VIBEDRIFT_API_URL = origApiUrl;
    else delete process.env.VIBEDRIFT_API_URL;
    await rm(tmpHome, { recursive: true, force: true });
  });

  describe("resolveToken", () => {
    it("returns null when nothing is configured anywhere", async () => {
      const { resolveToken } = await import("../../../src/auth/resolver.js");
      expect(await resolveToken()).toBeNull();
      expect(await resolveToken({})).toBeNull();
    });

    it("falls back through env then config when no flag is given", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      await writeConfig({ token: "config-token" });
      const { resolveToken } = await import("../../../src/auth/resolver.js");
      expect(await resolveToken()).toEqual({ token: "config-token", source: "config" });

      process.env.VIBEDRIFT_TOKEN = "env-token";
      expect(await resolveToken()).toEqual({ token: "env-token", source: "env" });
    });

    it("precedence: explicit flag beats env beats config", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      await writeConfig({ token: "config-token" });
      process.env.VIBEDRIFT_TOKEN = "env-token";
      const { resolveToken } = await import("../../../src/auth/resolver.js");

      // config alone
      delete process.env.VIBEDRIFT_TOKEN;
      expect((await resolveToken())?.source).toBe("config");

      // env beats config
      process.env.VIBEDRIFT_TOKEN = "env-token";
      expect(await resolveToken()).toEqual({ token: "env-token", source: "env" });

      // explicit flag beats env and config
      expect(await resolveToken({ explicitToken: "flag-token" })).toEqual({
        token: "flag-token",
        source: "flag",
      });
    });

    it("trims whitespace and treats whitespace-only as absent, falling through", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      await writeConfig({ token: "config-token" });
      const { resolveToken } = await import("../../../src/auth/resolver.js");

      // whitespace-only flag is treated as absent -> falls through to config
      expect(await resolveToken({ explicitToken: "   " })).toEqual({
        token: "config-token",
        source: "config",
      });

      // a real flag value is trimmed
      expect(await resolveToken({ explicitToken: "  flag-token  " })).toEqual({
        token: "flag-token",
        source: "flag",
      });

      // whitespace-only env is treated as absent -> falls through to config
      process.env.VIBEDRIFT_TOKEN = "   ";
      expect(await resolveToken()).toEqual({ token: "config-token", source: "config" });

      // a real env value is trimmed
      process.env.VIBEDRIFT_TOKEN = "  env-token  ";
      expect(await resolveToken()).toEqual({ token: "env-token", source: "env" });
    });
  });

  describe("resolveApiUrl", () => {
    it("falls back to the built-in default when nothing is configured", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      expect(await resolveApiUrl()).toBe("https://vibedrift-api.fly.dev");
    });

    it("precedence: explicit flag beats env beats config beats default", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");

      // default only
      expect(await resolveApiUrl()).toBe("https://vibedrift-api.fly.dev");

      // config beats default
      await writeConfig({ apiUrl: "https://config.example.com" });
      expect(await resolveApiUrl()).toBe("https://config.example.com");

      // env beats config
      process.env.VIBEDRIFT_API_URL = "https://env.example.com";
      expect(await resolveApiUrl()).toBe("https://env.example.com");

      // explicit flag beats env and config
      expect(await resolveApiUrl("https://flag.example.com")).toBe("https://flag.example.com");
    });

    it("trims whitespace and treats whitespace-only as absent, falling through", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      await writeConfig({ apiUrl: "https://config.example.com" });
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");

      // whitespace-only flag is treated as absent -> falls through to config
      expect(await resolveApiUrl("   ")).toBe("https://config.example.com");

      // a real flag value is trimmed
      expect(await resolveApiUrl("  https://flag.example.com  ")).toBe("https://flag.example.com");

      // whitespace-only env is treated as absent -> falls through to config
      process.env.VIBEDRIFT_API_URL = "   ";
      expect(await resolveApiUrl()).toBe("https://config.example.com");

      // a real env value is trimmed
      process.env.VIBEDRIFT_API_URL = "  https://env.example.com  ";
      expect(await resolveApiUrl()).toBe("https://env.example.com");
    });
  });

  /**
   * resolveApiUrl's return value is the URL every Bearer token gets sent to
   * (see auth/api.ts). An override can come from a flag, an env var, or the
   * on-disk config, any of which could be a bad copy-paste or a compromised
   * dotfile — http:// to a non-local host would ship the token in the clear.
   */
  describe("resolveApiUrl — refuses to send credentials over plaintext HTTP", () => {
    it("rejects a non-localhost http:// override", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      await expect(resolveApiUrl("http://evil.com")).rejects.toThrow(/insecure|https/i);
    });

    it("rejects a non-localhost http:// override from the env var", async () => {
      process.env.VIBEDRIFT_API_URL = "http://evil.com";
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      await expect(resolveApiUrl()).rejects.toThrow(/insecure|https/i);
    });

    it("rejects a non-localhost http:// override from config", async () => {
      const { writeConfig } = await import("../../../src/auth/config.js");
      await writeConfig({ apiUrl: "http://evil.com" });
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      await expect(resolveApiUrl()).rejects.toThrow(/insecure|https/i);
    });

    it("allows http://localhost for local development", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      expect(await resolveApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
    });

    it("allows http://127.0.0.1 for local development", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      expect(await resolveApiUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    });

    it("allows any https:// override", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      expect(await resolveApiUrl("https://staging.example.com")).toBe("https://staging.example.com");
    });

    it("warns to stderr when a non-default API URL is in effect", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await resolveApiUrl("https://staging.example.com");
        expect(stderrSpy).toHaveBeenCalled();
        const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes("non-default API URL"));
        expect(warned).toBe(true);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("does not warn when using the built-in default", async () => {
      const { resolveApiUrl } = await import("../../../src/auth/resolver.js");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await resolveApiUrl();
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
