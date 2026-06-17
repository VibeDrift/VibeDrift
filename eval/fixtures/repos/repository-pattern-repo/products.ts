export async function findProduct(repo, id) {
  const product = await repo.products.findById(id);
  if (!product) throw new NotFoundError("product");
  return product;
}

export async function saveProduct(repo, product) {
  const saved = await repo.products.upsert(product);
  return saved;
}
