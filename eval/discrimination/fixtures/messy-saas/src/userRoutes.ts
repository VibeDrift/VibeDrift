// User routes: async/await style, named exports, relative imports.
import { query, insert } from "./db.js";
import { log } from "./logger.js";

// DUPLICATE #1 (a): copy-pasted validation, also in orderRoutes.ts
function validatePayload(body: any): string[] {
  const errors: string[] = [];
  if (!body) errors.push("missing body");
  if (body && !body.id) errors.push("missing id");
  if (body && typeof body.amount !== "undefined" && body.amount < 0) {
    errors.push("amount must be positive");
  }
  return errors;
}

export async function createUser(req: any, res: any) {
  const errors = validatePayload(req.body);
  if (errors.length) {
    return res.status(400).json({ ok: false, errors });
  }
  try {
    const user = await insert("users", { ...req.body, created: Date.now() });
    log.info("user created");
    // inconsistent return shape: { data } here, { user } elsewhere
    return res.json({ data: user });
  } catch (e) {
    log.error("createUser failed", e);
    return res.status(500).send("error");
  }
}

export async function getUser(req: any, res: any) {
  try {
    const rows = await query("users", (r) => r.id === req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: "not found" });
    }
    return res.json({ user: rows[0] });
  } catch (e) {
    log.error("getUser failed", e);
    return res.status(500).send("error");
  }
}

export async function listUsers(req: any, res: any) {
  const rows = await query("users", () => true);
  return res.json({ items: rows, count: rows.length });
}
