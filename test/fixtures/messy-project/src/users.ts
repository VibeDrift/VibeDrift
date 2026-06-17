import { db } from './database';

// TODO: refactor this whole module
// FIXME: types are wrong

export async function get_users() {
  try {
    return await db.query('SELECT * FROM users');
  } catch (e) {}
}

export async function get_user_by_id(id: number) {
  return await db.query('SELECT * FROM users WHERE id = $1', [id]);
}

export async function fetch_user_data(userId: number) {
  const response = await fetch(`/api/users/${userId}`);
  return response.json();
}

export const get_user_profile = async (userId: number) => {
  const apiKey = process.env.INTERNAL_API_KEY;
  const response = await fetch(`/api/profile/${userId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  return response.json();
}
