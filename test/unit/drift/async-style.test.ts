import { describe, it, expect } from "vitest";
import { classifyAsyncStyle, asyncCounts } from "../../../src/drift/async-style.js";

// NOTE: counting is per-LINE (matching the async-consistency detector): a line
// containing `await` counts once, a line containing `.then(` counts once.

describe("classifyAsyncStyle (shared async-pattern classifier)", () => {
  it("classifies an await-dominant body as async_await", () => {
    const body = ["async function f(){", "  const a = await x();", "  const b = await y();", "  const c = await z();", "  return a;", "}"].join("\n");
    expect(classifyAsyncStyle(body)).toBe("async_await");
  });

  it("classifies a .then()-dominant body as then_chains", () => {
    const body = ["function f(){", "  return x()", "    .then(a => a)", "    .then(b => b)", "    .then(c => c);", "}"].join("\n");
    expect(classifyAsyncStyle(body)).toBe("then_chains");
  });

  it("classifies a balanced body as mixed", () => {
    const body = ["async function f(){", "  const a = await x();", "  return y().then(r => r);", "}"].join("\n");
    // 1 await line, 1 then line -> ratio 0.5 -> mixed
    expect(classifyAsyncStyle(body)).toBe("mixed");
  });

  it("returns null when there are fewer than 2 async operations", () => {
    expect(classifyAsyncStyle(["function f(){", "  const a = await x();", "  return a;", "}"].join("\n"))).toBeNull();
    expect(classifyAsyncStyle("function f(){ return 1 + 2; }")).toBeNull();
  });

  it("ignores await/then inside comments", () => {
    const body = ["function f(){", "  // await x()", "  // y().then(r => r)", "  return 1;", "}"].join("\n");
    expect(classifyAsyncStyle(body)).toBeNull();
  });

  it("asyncCounts reports per-line await and then counts", () => {
    const body = ["async function f(){", "  await a();", "  await b();", "  return c().then(x => x);", "}"].join("\n");
    expect(asyncCounts(body)).toEqual({ awaitCount: 2, thenCount: 1 });
  });
});
