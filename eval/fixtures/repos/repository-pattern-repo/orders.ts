export async function findOrder(repo, id) {
  const order = await repo.orders.findById(id);
  if (!order) throw new NotFoundError("order");
  return order;
}

export async function saveOrder(repo, order) {
  const saved = await repo.orders.upsert(order);
  return saved;
}
