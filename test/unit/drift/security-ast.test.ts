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

  it("unpacks array-literal middleware ([requireAuth]) to detect auth", async () => {
    const f = await fileWithTree("r.ts",
      `router.post("/x", [requireAuth], (req,res)=>{});\n`);
    expect(extractJsRoutesAst(f.tree!, f.relativePath, undefined)[0].hasAuth).toBe(true);
  });

  it("still reads hasAuth:false for a route with no middleware", async () => {
    const f = await fileWithTree("r.ts",
      `router.post("/x", (req,res)=>{});\n`);
    expect(extractJsRoutesAst(f.tree!, f.relativePath, undefined)[0].hasAuth).toBe(false);
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

  // ─── REGRESSION: string literals inside the argument list blessed the file ──
  //
  // The lane used to regex-test the arguments' RAW TEXT, which includes string
  // literals. A mount path or an asset directory whose NAME happens to contain an
  // auth word therefore set hasAuth for the whole file, and every route in it
  // inherited the bless — a file-wide false bless off a string. Per-route
  // middleware already went through the structural middlewareNames() helper; this
  // lane now uses the same one.
  //
  // These bind: swap middlewareNames() back for `arguments.text` and each case
  // below returns hasAuth/hasValidation/hasRateLimit true.
  it("a mount PATH containing an auth word does not bless the file", async () => {
    const f = await fileWithTree("app.ts", `app.use("/jwt", staticRouter);\napp.get("/x", h);\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
  });

  it("a STRING ARGUMENT to a non-auth middleware does not bless the file", async () => {
    const f = await fileWithTree("s.ts", `app.use(express.static("passport-photos"));\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
  });

  it("the validation and rate-limit lanes are string-proof too", async () => {
    const f = await fileWithTree("s2.ts",
      `app.use("/validate", pageRouter);\napp.use("/rateLimit", docsRouter);\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
  });

  it("a real mounted middleware still blesses through a mount path", async () => {
    // Non-vacuity: the structural read must still see the IDENTIFIER argument.
    const f = await fileWithTree("ok.ts", `app.use("/api", requireAuth);\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: false });
  });

  it("a call-form middleware still blesses (callee name, never its arguments)", async () => {
    const f = await fileWithTree("ok2.ts", `app.use(passport.authenticate("jwt"));\napp.use(rateLimit({ max: 5 }));\n`);
    expect(extractFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: true });
  });
});
