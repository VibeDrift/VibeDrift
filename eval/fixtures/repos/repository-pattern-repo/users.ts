export async function findUser(repo, id) {
  const user = await repo.users.findById(id);
  if (!user) throw new NotFoundError("user");
  return user;
}

export async function saveUser(repo, user) {
  const saved = await repo.users.upsert(user);
  return saved;
}
