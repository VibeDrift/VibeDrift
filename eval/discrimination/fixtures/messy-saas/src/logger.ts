// Two logging styles coexist: a class and loose console calls elsewhere.

class Logger {
  info(msg: string) {
    console.log("[info] " + msg);
  }
  error(msg: string, err?: any) {
    console.error("[error] " + msg, err);
  }
}

export const log = new Logger();

export function debug_log(msg: string) {
  if (process.env.DEBUG) {
    console.log("DEBUG: " + msg);
  }
}
