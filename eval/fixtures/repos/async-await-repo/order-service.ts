export async function getOrder(id: string) {
  const row = await db.orders.findById(id);
  const items = await db.items.forOrder(id);
  if (!row) throw new NotFoundError("order");
  return { ...row, items };
}

export async function listOrders(limit: number) {
  const rows = await db.orders.findMany(limit);
  const total = await db.orders.count();
  return { rows, total };
}
