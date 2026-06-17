export async function getInvoice(id: string) {
  const row = await db.invoices.findById(id);
  const lines = await db.lines.forInvoice(id);
  if (!row) throw new NotFoundError("invoice");
  return { ...row, lines };
}

export async function listInvoices(limit: number) {
  const rows = await db.invoices.findMany(limit);
  const total = await db.invoices.count();
  return { rows, total };
}
