export function getUser(id) {
  return db.users
    .findById(id)
    .then((row) => enrich(row))
    .then((user) => ({ ...user, loaded: true }));
}

export function listUsers(limit) {
  return db.users
    .findMany(limit)
    .then((rows) => rows.map(enrich))
    .then((users) => ({ users, count: users.length }));
}
