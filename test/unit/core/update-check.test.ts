import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { semverGreater } from "../../../src/core/update-check.js";

describe("semverGreater", () => {
  it("returns true when the first is strictly greater", () => {
    expect(semverGreater("0.6.1", "0.6.0")).toBe(true);
    expect(semverGreater("0.7.0", "0.6.99")).toBe(true);
    expect(semverGreater("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false when equal or smaller", () => {
    expect(semverGreater("0.6.0", "0.6.0")).toBe(false);
    expect(semverGreater("0.5.9", "0.6.0")).toBe(false);
    expect(semverGreater("0.6.0", "0.6.1")).toBe(false);
  });

  it("handles missing components by treating them as zero", () => {
    expect(semverGreater("0.6", "0.5.9")).toBe(true);
    expect(semverGreater("0.5.9", "0.6")).toBe(false);
    expect(semverGreater("1", "0.99.99")).toBe(true);
  });

  it("handles non-numeric components gracefully (parseInt NaN → 0)", () => {
    // Pre-release identifiers like "0.6.0-alpha" aren't officially
    // supported by the simple splitter, but shouldn't throw. The "alpha"
    // component becomes NaN, fallback to 0 — so 0.6.0 and 0.6.0-alpha
    // appear equal. Documents current behavior.
    expect(() => semverGreater("0.6.0-alpha", "0.6.0")).not.toThrow();
    expect(semverGreater("0.6.0-alpha", "0.6.0")).toBe(false);
  });
});

describe("checkForUpdate (cache + fetch behavior)", () => {
  // Redirect HOME to a temp dir so cache writes are isolated per test.
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "vd-update-check-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Reset the module registry so the cache-path constant re-resolves
    // against the new HOME (the module reads homedir() at import).
    vi.resetModules();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("returns null silently when the registry fetch fails", async () => {
    // Stub global fetch to reject.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("serves from cache within TTL without hitting the network", async () => {
    // Write a fresh cache entry manually.
    await mkdir(join(tmpHome, ".vibedrift"), { recursive: true });
    await writeFile(
      join(tmpHome, ".vibedrift", "version-check.json"),
      JSON.stringify({ latest: "0.7.0", checkedAt: Date.now() }),
    );

    // Stub fetch to throw — if cache is hit, it should never be called.
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(fetchCalled).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.latest).toBe("0.7.0");
      expect(result!.outdated).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("ignores a stale cache entry and refetches", async () => {
    // Write a cache entry with checkedAt from 48 hours ago.
    await mkdir(join(tmpHome, ".vibedrift"), { recursive: true });
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    await writeFile(
      join(tmpHome, ".vibedrift", "version-check.json"),
      JSON.stringify({ latest: "0.5.0", checkedAt: twoDaysAgo }),
    );

    // Stub fetch to return a newer version than the stale cache entry.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ version: "0.7.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result!.latest).toBe("0.7.0");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("reports not-outdated when the user is on the latest", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ version: "0.6.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result).not.toBeNull();
      expect(result!.outdated).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("reports outdated when the user is on an older version", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ version: "0.7.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result).not.toBeNull();
      expect(result!.outdated).toBe(true);
      expect(result!.current).toBe("0.6.0");
      expect(result!.latest).toBe("0.7.0");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns null on non-OK registry response", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns null when the registry response is missing a version field", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ other: "field" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const { checkForUpdate } = await import("../../../src/core/update-check.js");
      const result = await checkForUpdate("0.6.0");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
