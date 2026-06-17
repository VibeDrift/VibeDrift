export async function findAccount(repo, id) {
  const account = await repo.accounts.findById(id);
  if (!account) throw new NotFoundError("account");
  return account;
}

export async function saveAccount(repo, account) {
  const saved = await repo.accounts.upsert(account);
  return saved;
}
