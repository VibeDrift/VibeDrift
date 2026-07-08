import { describe, it, expect } from "vitest";
import { extractJsRoutesAst } from "../../../src/drift/security-ast.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

describe("extractJsRoutesAst", () => {
  it("extracts routes and reads per-route auth from the middleware argument", async () => {
    const f = await fileWithTree("routes.ts",
      `router.post("/orders", requireAuth, createOrder);\n` +
      `router.get("/orders", listOrders);\n`);
    const routes = extractJsRoutesAst(f.tree!, f.path, undefined);
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
    expect(extractJsRoutesAst(f.tree!, f.path, undefined)).toEqual([]);
  });

  it("reads passport.authenticate(...) call middleware", async () => {
    const f = await fileWithTree("r.ts",
      `router.get("/me", passport.authenticate("jwt"), getMe);\n`);
    expect(extractJsRoutesAst(f.tree!, f.path, undefined)[0].hasAuth).toBe(true);
  });
});
