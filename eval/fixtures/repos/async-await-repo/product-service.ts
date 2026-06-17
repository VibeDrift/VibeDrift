export async function getProduct(id: string) {
  const row = await db.products.findById(id);
  const price = await db.prices.forProduct(id);
  if (!row) throw new NotFoundError("product");
  return { ...row, price };
}

export async function listProducts(limit: number) {
  const rows = await db.products.findMany(limit);
  const total = await db.products.count();
  return { rows, total };
}
