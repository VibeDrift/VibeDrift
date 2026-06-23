// Sessions: default export, .then() chains, snake_case, DUPLICATE #3 (b).
import db from "@/db";

// DUPLICATE #3 (b): near-identical id maker from utils.ts
function make_id(prefix: string): string {
  return prefix + "_" + Math.random().toString(36).substring(2, 11);
}

function start_session(userId: string) {
  const token = make_id("sess");
  return db.insert("sessions", { token, userId, created: Date.now() }).then((row) => {
    return { token: row.token }; // yet another return shape
  });
}

// PHANTOM: exported but unused
export function end_session(token: string) {
  return db.query("sessions", (r: any) => r.token !== token);
}

export default {
  start_session,
};
