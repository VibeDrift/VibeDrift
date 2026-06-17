export async function getProduct(id) {
  const row = await db.products.findById(id);
  if (!row) throw new Error("product not found");
  return row;
}

export async function listProducts(limit) {
  const rows = await db.products.findMany(limit);
  return rows;
}
