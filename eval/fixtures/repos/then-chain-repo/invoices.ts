export function getInvoice(id) {
  return db.invoices
    .findById(id)
    .then((row) => enrich(row))
    .then((invoice) => ({ ...invoice, loaded: true }));
}

export function listInvoices(limit) {
  return db.invoices
    .findMany(limit)
    .then((rows) => rows.map(enrich))
    .then((invoices) => ({ invoices, count: invoices.length }));
}
