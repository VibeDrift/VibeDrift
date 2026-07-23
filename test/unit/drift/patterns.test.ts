import { describe, it, expect } from "vitest";
import {
  GO_ROUTE_ECHO, GO_ROUTE_GORILLA, GO_AUTH, GO_VALIDATION, GO_RATE_LIMIT, GO_ERROR_HANDLER,
  JS_ROUTE, JS_METHOD, JS_AUTH, JS_VALIDATION, JS_RATE_LIMIT, JS_ERROR_HANDLER,
  PY_ROUTE, PY_DECORATOR_VERB, PY_METHODS_KWARG, PY_METHODS_VERBS, PY_AUTH, PY_VALIDATION, PY_RATE_LIMIT, PY_ERROR_HANDLER,
} from "../../../src/drift/route-extractors/patterns.js";

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
