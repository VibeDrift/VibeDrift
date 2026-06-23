// Order routes: .then() chains, snake_case fn names, default export, alias imports.
import db from "@/db";
import { log } from "@/logger";

// DUPLICATE #1 (b): near-identical to validatePayload in userRoutes.ts
function validate_payload(body: any): string[] {
  const errors: string[] = [];
  if (!body) errors.push("missing body");
  if (body && !body.id) errors.push("missing id");
  if (body && typeof body.amount !== "undefined" && body.amount < 0) {
    errors.push("amount must be positive");
  }
  return errors;
}

function create_order(req: any, res: any) {
  const errors = validate_payload(req.body);
  if (errors.length) {
    res.status(400).json({ ok: false, errors });
    return;
  }
  db
    .insert("orders", { ...req.body, created: Date.now() })
    .then((order) => {
      log.info("order created");
      // inconsistent return shape vs userRoutes
      res.json({ order: order, success: true });
    })
    .catch((err) => {
      log.error("create_order failed", err);
      res.status(500).send("error");
    });
}

function get_order(req: any, res: any) {
  db
    .query("orders", (r: any) => r.id === req.params.id)
    .then((rows: any[]) => {
      if (!rows.length) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ order: rows[0] });
    })
    .catch((err: any) => {
      log.error("get_order failed", err);
      res.status(500).send("error");
    });
}

function list_orders(req: any, res: any) {
  db.query("orders", () => true).then((rows: any[]) => {
    res.send(rows);
  });
}

export default {
  create_order,
  get_order,
  list_orders,
};
