import { describe, it, expect } from "vitest";
import { extractJsRoutesAst, extractFileMiddlewareAst } from "../../../src/drift/security-ast.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

describe("extractJsRoutesAst", () => {
  it("extracts routes and reads per-route auth from the middleware argument", async () => {
    const f = await fileWithTree("routes.ts",
      `router.post("/orders", requireAuth, createOrder);\n` +
      `router.get("/orders", listOrders);\n`);
    const routes = extractJsRoutesAst(f.tree!, f.relativePath, undefined);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=true",
      "GET /orders auth=false",
    ]);
  });

  it("does NOT capture non-router receivers (cache/c/headers/config over-capture)", async () => {
    const f = await fileWithTree("svc.ts",
      `cache.get("user:1");\n` +
      `c.get("session");\n` +
      `req.headers.get("content-type");\n` +
      `config.get("PORT");\n` +
      `axios.get("https://x.test/y");\n`);
    expect(extractJsRoutesAst(f.tree!, f.relativePath, undefined)).toEqual([]);
  });

  it("reads passport.authenticate(...) call middleware", async () => {
    const f = await fileWithTree("r.ts",
      `router.get("/me", passport.authenticate("jwt"), getMe);\n`);
    expect(extractJsRoutesAst(f.tree!, f.relativePath, undefined)[0].hasAuth).toBe(true);
  });
});

describe("extractFileMiddlewareAst", () => {
  it("detects router-level auth middleware from .use()", async () => {
    const f = await fileWithTree("app.ts", `router.use(requireAuth);\nrouter.get("/x", h);\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: false });
  });
  it("ignores .use() on non-router receivers", async () => {
    const f = await fileWithTree("m.ts", `emitter.use(requireAuth);\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
  });
});
