export async function getAccount(id) {
  const row = await db.accounts.findById(id);
  if (!row) throw new Error("account not found");
  return row;
}

export async function listAccounts(limit) {
  const rows = await db.accounts.findMany(limit);
  return rows;
}
