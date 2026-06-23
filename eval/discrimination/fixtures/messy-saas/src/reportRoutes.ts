// Report routes: alias imports, default export, async/await.
import { query } from "@/db";

// DUPLICATE #2 (b): near-identical money formatter from invoiceRoutes.ts
function format_money(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  const padded = rem < 10 ? "0" + rem : String(rem);
  return "$" + dollars + "." + padded;
}

async function monthlyReport(req: any, res: any) {
  const orders = await query("orders", () => true);
  const total = orders.reduce((sum: number, o: any) => sum + (o.amount || 0), 0);
  res.json({ total: format_money(total), count: orders.length });
}

// PHANTOM: exported, wired nowhere, never imported
export async function quarterlyReport(req: any, res: any) {
  const orders = await query("orders", () => true);
  res.json({ note: "not implemented", total: 0 });
}

export default {
  monthlyReport,
};
