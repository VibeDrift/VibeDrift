export async function findInvoice(repo, id) {
  const invoice = await repo.invoices.findById(id);
  if (!invoice) throw new NotFoundError("invoice");
  return invoice;
}

export async function saveInvoice(repo, invoice) {
  const saved = await repo.invoices.upsert(invoice);
  return saved;
}
