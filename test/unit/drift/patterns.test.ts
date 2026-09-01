import { describe, it, expect } from "vitest";
import {
  GO_ROUTE_ECHO, GO_ROUTE_GORILLA, GO_AUTH, GO_VALIDATION, GO_RATE_LIMIT, GO_ERROR_HANDLER,
  JS_ROUTE, JS_METHOD, JS_AUTH, JS_VALIDATION, JS_RATE_LIMIT, JS_ERROR_HANDLER,
  PY_ROUTE, PY_DECORATOR_VERB, PY_METHODS_KWARG, PY_METHODS_VERBS, PY_AUTH, PY_VALIDATION, PY_RATE_LIMIT, PY_ERROR_HANDLER,
} from "../../../src/drift/route-extractors/patterns.js";
import { SECURITY_AST } from "../../../src/drift/security-ast.js";

/**
 * Unit tests for the per-language route-fallback regexes (PR #70 review ask:
 * "put the regexes in a separate file and test them individually to make sure
 * for every language the regex captures the correct match group").
 *
 * Route patterns are checked for their capture groups (method / path); the
 * boolean signal detectors are checked for representative positives + negatives.
 */

describe("Go patterns", () => {
  it("GO_ROUTE_ECHO captures [1]=method, [2]=path", () => {
    const m = `r.POST("/users", h)`.match(GO_ROUTE_ECHO);
    expect(m?.[1]).toBe("POST");
    expect(m?.[2]).toBe("/users");
  });
  it("GO_ROUTE_GORILLA captures [1]=path, [2]=method", () => {
    const m = `r.HandleFunc("/admin", h).Methods("PUT")`.match(GO_ROUTE_GORILLA);
    expect(m?.[1]).toBe("/admin");
    expect(m?.[2]).toBe("PUT");
  });
  it("GO_ROUTE_ECHO ignores a non-verb call", () => {
    expect(`r.Group("/api")`.match(GO_ROUTE_ECHO)).toBeNull();
  });
  it("signal detectors match / reject", () => {
    expect(GO_AUTH.test("requireAuth(c)")).toBe(true);
    expect(GO_AUTH.test("return json(c)")).toBe(false);
    expect(GO_VALIDATION.test("c.Bind(&o)")).toBe(true);
    expect(GO_VALIDATION.test("c.JSON(200, o)")).toBe(false);
    expect(GO_RATE_LIMIT.test("rateLimiter.Wait()")).toBe(true);
    expect(GO_RATE_LIMIT.test("logger.Info()")).toBe(false);
    expect(GO_ERROR_HANDLER.test("if err != nil {")).toBe(true);
    expect(GO_ERROR_HANDLER.test("return nil")).toBe(false);
  });
});

describe("JS/TS patterns", () => {
  it("JS_ROUTE captures [1]=path and JS_METHOD captures [1]=verb", () => {
    const m = `router.post('/secure', h)`.match(JS_ROUTE);
    expect(m?.[1]).toBe("/secure");
    expect(m?.[0].match(JS_METHOD)?.[1]).toBe("post");
  });
  it("JS_ROUTE supports template-literal and double-quote paths", () => {
    expect("app.get(`/t`, h)".match(JS_ROUTE)?.[1]).toBe("/t");
    expect('app.delete("/d", h)'.match(JS_ROUTE)?.[1]).toBe("/d");
  });
  it("JS_ROUTE ignores a non-route method call", () => {
    expect(`router.use(mw)`.match(JS_ROUTE)).toBeNull();
  });
  it("signal detectors match / reject", () => {
    expect(JS_AUTH.test("passport.authenticate('jwt')")).toBe(true);
    expect(JS_AUTH.test("res.send(data)")).toBe(false);
    expect(JS_VALIDATION.test("celebrate(schema)")).toBe(true);
    expect(JS_VALIDATION.test("res.json(x)")).toBe(false);
    expect(JS_RATE_LIMIT.test("rateLimit({})")).toBe(true);
    expect(JS_RATE_LIMIT.test("next()")).toBe(false);
    expect(JS_ERROR_HANDLER.test("next(err)")).toBe(true);
    expect(JS_ERROR_HANDLER.test("res.end()")).toBe(false);
  });
});

describe("Python patterns", () => {
  it("PY_ROUTE captures [1]=path", () => {
    expect(`@app.route("/x")`.match(PY_ROUTE)?.[1]).toBe("/x");
    expect(`@app.post("/y")`.match(PY_ROUTE)?.[1]).toBe("/y");
  });
  it("PY_DECORATOR_VERB captures [1]=verb", () => {
    expect(`@app.post(`.match(PY_DECORATOR_VERB)?.[1]).toBe("post");
    expect(`@app.route(`.match(PY_DECORATOR_VERB)).toBeNull(); // route has no verb
  });
  it("PY_METHODS_KWARG + PY_METHODS_VERBS pull the verb list", () => {
    const kw = `methods=["GET", "POST"]`.match(PY_METHODS_KWARG);
    expect(kw?.[1]).toBe(`"GET", "POST"`);
    const verbs = kw![1].match(PY_METHODS_VERBS)?.map((v) => v.replace(/["']/g, ""));
    expect(verbs).toEqual(["GET", "POST"]);
  });
  it("signal detectors match / reject", () => {
    expect(PY_AUTH.test("@login_required")).toBe(true);
    expect(PY_AUTH.test("def index():")).toBe(false);
    expect(PY_VALIDATION.test("class S(Schema):")).toBe(true);
    expect(PY_VALIDATION.test("return jsonify(x)")).toBe(false);
    expect(PY_RATE_LIMIT.test("@limiter.limit('1/s')")).toBe(true);
    expect(PY_RATE_LIMIT.test("print(x)")).toBe(false);
    expect(PY_ERROR_HANDLER.test("except ValueError:")).toBe(true);
    expect(PY_ERROR_HANDLER.test("return data")).toBe(false);
  });
});

// ─── REGRESSION: the two gates the JS_ROUTE fallback was missing ─────────────
//
// security-ast.ts:11-17 documents two structural gates for a route call — a
// router-like receiver and a leading-slash path — and the AST path applies both.
// The regex fallback applied NEITHER, so in any file tree-sitter could not parse,
// `cache.get("user:1")` and `config.get("PORT")` became phantom routes that then
// voted in (and skewed) the auth dominance vote.
//
// These bind: drop either gate from JS_ROUTE and the phantom cases below match.
describe("JS_ROUTE: receiver + leading-slash gates (regression)", () => {
  it("rejects a non-router receiver with a route-shaped call", () => {
    expect(`cache.get("user:1")`.match(JS_ROUTE)).toBeNull();
    expect(`config.get("PORT")`.match(JS_ROUTE)).toBeNull();
    expect(`axios.get("/api/thing")`.match(JS_ROUTE)).toBeNull();
    expect(`redis.delete("/tmp/key")`.match(JS_ROUTE)).toBeNull();
  });

  it("rejects a router receiver whose first argument is not a leading-slash path", () => {
    expect(`router.get("user:1")`.match(JS_ROUTE)).toBeNull();
    expect(`app.get("PORT")`.match(JS_ROUTE)).toBeNull();
  });

  it("still matches every real router receiver shape, capturing [1]=path", () => {
    expect(`app.post("/a", h)`.match(JS_ROUTE)?.[1]).toBe("/a");
    expect(`router.put("/b", h)`.match(JS_ROUTE)?.[1]).toBe("/b");
    expect(`api.delete("/c", h)`.match(JS_ROUTE)?.[1]).toBe("/c");
    expect(`v1.patch("/d", h)`.match(JS_ROUTE)?.[1]).toBe("/d");
    expect(`userRouter.all("/e", h)`.match(JS_ROUTE)?.[1]).toBe("/e");
    // A member receiver resolves to its nearest property on the AST path, so the
    // fallback must accept a preceding dot too.
    expect(`this.router.get("/f", h)`.match(JS_ROUTE)?.[1]).toBe("/f");
  });

  it("a receiver embedded in a longer identifier does not count", () => {
    expect(`myapp.get("/x")`.match(JS_ROUTE)).toBeNull();
    expect(`apiClient.get("/x")`.match(JS_ROUTE)).toBeNull();
  });

  it("the inlined receiver vocabulary agrees with SECURITY_AST.ROUTER_RECEIVER", () => {
    // The AST gate and this fallback must accept the same receiver set; a drift
    // between them is exactly how the fallback got its phantom routes.
    const receivers = [
      "app", "application", "server", "router", "api", "route", "v1", "v22",
      "userRouter", "adminrouter", "cache", "config", "axios", "redis", "client",
      "myapp", "apiClient", "c", "req",
    ];
    for (const r of receivers) {
      expect(`${r}.get("/x", h)`.match(JS_ROUTE) !== null).toBe(
        SECURITY_AST.ROUTER_RECEIVER.test(r),
      );
    }
  });
});

// ─── REGRESSION: auth patterns matched credential NOUNS, not enforcement ─────
//
// PY_AUTH's bare `token` matched a /login handler's own `access_token` response
// inside the 30-line window python.ts reads from the route decorator, so the
// route that MINTS a credential blessed itself as authenticated. JS_AUTH's bare
// `jwt` and GO_AUTH's bare `[Aa]uth` / `[Tt]oken` are the same class.
//
// These bind: restore any bare alternate and its false-positive case below fires.
describe("auth patterns: enforcement shapes only (regression)", () => {
  it("PY_AUTH does not match credential-minting or authorization nouns", () => {
    expect(PY_AUTH.test(`    return {"access_token": access_token}`)).toBe(false);
    expect(PY_AUTH.test(`    access_token = create_access_token(identity=user.id)`)).toBe(false);
    expect(PY_AUTH.test(`    # token validated upstream`)).toBe(false);
    expect(PY_AUTH.test(`    permission = row.permission`)).toBe(false);
    expect(PY_AUTH.test(`    csrf_token = generate_csrf()`)).toBe(false);
  });

  it("PY_AUTH still matches real enforcement shapes", () => {
    expect(PY_AUTH.test("@login_required")).toBe(true);
    expect(PY_AUTH.test("@jwt_required()")).toBe(true);
    expect(PY_AUTH.test("@requires_auth")).toBe(true);
    expect(PY_AUTH.test("@auth.login_required")).toBe(true);
    expect(PY_AUTH.test("@permission_classes([IsAuthenticated])")).toBe(true);
    expect(PY_AUTH.test("def me(user = Depends(get_current_user)):")).toBe(true);
    expect(PY_AUTH.test("    verify_jwt_in_request()")).toBe(true);
    expect(PY_AUTH.test("    if not current_user.is_authenticated:")).toBe(true);
  });

  it("JS_AUTH does not match token issuance or a jsonwebtoken import", () => {
    expect(JS_AUTH.test(`const jwt = require("jsonwebtoken");`)).toBe(false);
    expect(JS_AUTH.test(`const token = jwt.sign(payload, jwtSecret);`)).toBe(false);
    expect(JS_AUTH.test(`res.json({ jwt: token });`)).toBe(false);
  });

  it("JS_AUTH still matches real enforcement shapes", () => {
    expect(JS_AUTH.test("passport.authenticate('jwt')")).toBe(true);
    expect(JS_AUTH.test("router.post('/x', requireAuth, h)")).toBe(true);
    expect(JS_AUTH.test("app.use(authMiddleware)")).toBe(true);
    expect(JS_AUTH.test("app.use(jwt({ secret }))")).toBe(true);
    expect(JS_AUTH.test("if (!isAuthenticated(req)) return")).toBe(true);
  });

  it("GO_AUTH does not match authorship, header writes, or token issuance", () => {
    expect(GO_AUTH.test(`\tpost.Author = user.Name`)).toBe(false);
    expect(GO_AUTH.test(`\tw.Header().Set("Authorization", v)`)).toBe(false);
    expect(GO_AUTH.test(`\ttoken, err := issueToken(user)`)).toBe(false);
    expect(GO_AUTH.test(`\toauthConfig := oauth2.Config{}`)).toBe(false);
  });

  it("GO_AUTH still matches real enforcement shapes", () => {
    expect(GO_AUTH.test("requireAuth(c)")).toBe(true);
    expect(GO_AUTH.test("\tr.Use(authMiddleware)")).toBe(true);
    expect(GO_AUTH.test("\tr.Use(AuthMiddleware)")).toBe(true);
    expect(GO_AUTH.test("\tr.Use(middleware.RequireAuth)")).toBe(true);
    expect(GO_AUTH.test("\tr.Use(auth.Middleware())")).toBe(true);
    expect(GO_AUTH.test("\tif !VerifyToken(t) { return }")).toBe(true);
  });
});
