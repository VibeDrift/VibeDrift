// Invoice routes: mixes await AND .then() in the same file, mixed naming.
import { query, insert } from "./db.js";
import { log } from "./logger.js";

export async function createInvoice(req: any, res: any) {
  try {
    const inv = await insert("invoices", { ...req.body, created: Date.now() });
    console.log("invoice created"); // raw console, not log.info
    return res.json({ invoice: inv });
  } catch (e) {
    return res.status(500).send("error");
  }
}

// snake_case sibling using .then() for the exact same concern
export function get_invoice(req: any, res: any) {
  query("invoices", (r) => r.id === req.params.id).then((rows) => {
    if (!rows.length) {
      res.status(404).end();
      return;
    }
    res.json(rows[0]); // bare object, no envelope — third return shape
  });
}

// DUPLICATE #2 (a): money formatter, also pasted in reportRoutes.ts
export function formatMoney(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  const padded = rem < 10 ? "0" + rem : String(rem);
  return "$" + dollars + "." + padded;
}
