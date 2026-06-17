export function getOrder(id) {
  return db.orders
    .findById(id)
    .then((row) => enrich(row))
    .then((order) => ({ ...order, loaded: true }));
}

export function listOrders(limit) {
  return db.orders
    .findMany(limit)
    .then((rows) => rows.map(enrich))
    .then((orders) => ({ orders, count: orders.length }));
}
