export function getAccount(id) {
  return db.accounts
    .findById(id)
    .then((row) => enrich(row))
    .then((account) => ({ ...account, loaded: true }));
}

export function listAccounts(limit) {
  return db.accounts
    .findMany(limit)
    .then((rows) => rows.map(enrich))
    .then((accounts) => ({ accounts, count: accounts.length }));
}
