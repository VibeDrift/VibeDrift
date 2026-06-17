export async function getInvoice(id) {
  const row = await db.invoices.findById(id);
  if (!row) throw new Error("invoice not found");
  return row;
}

export async function listInvoices(accountId) {
  const rows = await db.invoices.findByAccount(accountId);
  return rows;
}
