export function getProduct(id) {
  return db.products
    .findById(id)
    .then((row) => enrich(row))
    .then((product) => ({ ...product, loaded: true }));
}

export function listProducts(limit) {
  return db.products
    .findMany(limit)
    .then((rows) => rows.map(enrich))
    .then((products) => ({ products, count: products.length }));
}
