// App wiring. Mixes named + default + alias imports. Only some handlers are wired.
import { createUser, getUser, listUsers } from "./userRoutes.js";
import orderRoutes from "@/orderRoutes";
import { createInvoice, get_invoice, formatMoney } from "./invoiceRoutes.js";
import reportRoutes from "@/reportRoutes";
import session from "@/session";
import { log } from "./logger.js";

type Handler = (req: any, res: any) => any;
const routes: Record<string, Handler> = {};

function register(method: string, path: string, handler: Handler) {
  routes[`${method} ${path}`] = handler;
}

// users — wired
register("POST", "/users", createUser);
register("GET", "/users/:id", getUser);
register("GET", "/users", listUsers);

// orders — wired via default export bundle
register("POST", "/orders", orderRoutes.create_order);
register("GET", "/orders/:id", orderRoutes.get_order);
register("GET", "/orders", orderRoutes.list_orders);

// invoices — only two of three wired (get_invoice + createInvoice)
register("POST", "/invoices", createInvoice);
register("GET", "/invoices/:id", get_invoice);

// reports — only monthly wired; quarterlyReport is phantom
register("GET", "/reports/monthly", reportRoutes.monthlyReport);

export function handle(method: string, path: string, req: any, res: any) {
  const key = `${method} ${path}`;
  const h = routes[key];
  if (!h) {
    log.info("no route for " + key);
    res.status(404).end();
    return;
  }
  return h(req, res);
}

// uses formatMoney + session so they're not all dead, but most exports drift
export function boot() {
  log.info("price example " + formatMoney(12345));
  session.start_session("usr_demo");
}
