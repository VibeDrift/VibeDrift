export async function getUser(id: string) {
  const row = await db.users.findById(id);
  const roles = await db.roles.forUser(id);
  if (!row) throw new NotFoundError("user");
  return { ...row, roles };
}

export async function listUsers(limit: number) {
  const rows = await db.users.findMany(limit);
  const total = await db.users.count();
  return { rows, total };
}
