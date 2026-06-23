// Auth helpers: mixed naming, several unused/dead exports (phantom scaffolding).
import { query } from "./db.js";

export function hashPassword(pw: string): string {
  // toy hash, not real
  let h = 0;
  for (let i = 0; i < pw.length; i++) {
    h = (h << 5) - h + pw.charCodeAt(i);
  }
  return String(h);
}

// PHANTOM: dead CRUD scaffolding, never called anywhere
export function verify_password(pw: string, hash: string): boolean {
  return hashPassword(pw) === hash;
}

// PHANTOM: never imported
export function rotate_token(token: string): string {
  return token.split("").reverse().join("");
}

// PHANTOM: stub handler, wired nowhere
export async function refreshSession(req: any, res: any) {
  const rows = await query("sessions", (r) => r.token === req.body?.token);
  if (!rows.length) {
    return res.status(401).end();
  }
  return res.json({ ok: true });
}

export default hashPassword;
