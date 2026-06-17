export async function getAccount(id: string) {
  const row = await db.accounts.findById(id);
  const owner = await db.users.findById(row.ownerId);
  if (!row) throw new NotFoundError("account");
  return { ...row, owner };
}

export async function listAccounts(limit: number) {
  const rows = await db.accounts.findMany(limit);
  const total = await db.accounts.count();
  return { rows, total };
}
