/**
 * Generates a uniform-pattern baseline TS project in memory.
 * ~31 files with consistent naming, architecture, error handling, and
 * (route files) security posture. Every file below is "dominant pattern" —
 * so any deviation injected on top of this baseline is unambiguously drift.
 */

export interface BaselineFile {
  path: string;
  content: string;
}

function handler(name: string): BaselineFile {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    path: `src/handlers/${name}Handler.ts`,
    content: `import { ${cap}Repository } from "../repos/${name}Repository.js";
import { NotFoundError } from "../errors/NotFoundError.js";

export async function get${cap}(id: string) {
  const repo = new ${cap}Repository();
  const row = await repo.findById(id);
  if (!row) {
    throw new NotFoundError(\`${cap} \${id} not found\`);
  }
  return row;
}

export async function list${cap}s() {
  const repo = new ${cap}Repository();
  return repo.findAll();
}
`,
  };
}

function repo(name: string): BaselineFile {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    path: `src/repos/${name}Repository.ts`,
    content: `import { getDatabase } from "../db/database.js";

export class ${cap}Repository {
  async findById(id: string) {
    const db = getDatabase();
    return db.${name}.findOne({ id });
  }

  async findAll() {
    const db = getDatabase();
    return db.${name}.findMany({});
  }
}
`,
  };
}

function service(name: string): BaselineFile {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    path: `src/services/${name}Service.ts`,
    content: `import { ${cap}Repository } from "../repos/${name}Repository.js";
import { ValidationError } from "../errors/ValidationError.js";

export async function create${cap}(input: { name: string }) {
  if (!input.name || input.name.length === 0) {
    throw new ValidationError("name is required");
  }
  const repo = new ${cap}Repository();
  return repo.findAll();
}
`,
  };
}

// Route files: every one registers a mutating (POST) endpoint uniformly
// guarded by `requireAuth`, using real `router.post("/x", requireAuth, handler)`
// syntax the AST route extractor (security-ast.ts) understands — receiver
// "router", a leading-slash path literal, and a middleware arg between the
// path and the handler. All 8 live in the same directory (src/routes/) so
// the route-consistency detector's per-directory dominance vote groups them
// together: a dominant "authed" pattern to deviate from.
function route(name: string): BaselineFile {
  return {
    path: `src/routes/${name}.ts`,
    content: `import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/${name}", requireAuth, async (req, res) => {
  res.json({ ok: true });
});

export default router;
`,
  };
}

export function generateBaseline(): BaselineFile[] {
  const entities = ["user", "order", "product", "payment", "invoice", "cart"];
  const files: BaselineFile[] = [];

  for (const e of entities) {
    files.push(handler(e));
    files.push(repo(e));
    files.push(service(e));
  }

  files.push({
    path: "src/db/database.ts",
    content: `export function getDatabase() {
  return {
    user: { findOne: async () => null, findMany: async () => [] },
    order: { findOne: async () => null, findMany: async () => [] },
    product: { findOne: async () => null, findMany: async () => [] },
    payment: { findOne: async () => null, findMany: async () => [] },
    invoice: { findOne: async () => null, findMany: async () => [] },
    cart: { findOne: async () => null, findMany: async () => [] },
  };
}
`,
  });

  files.push({
    path: "src/errors/NotFoundError.ts",
    content: `export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
`,
  });

  files.push({
    path: "src/errors/ValidationError.ts",
    content: `export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
`,
  });

  files.push({
    path: "package.json",
    content: `{
  "name": "calibration-baseline",
  "version": "1.0.0",
  "type": "module"
}
`,
  });

  files.push({
    path: "src/middleware/auth.ts",
    content: `export function requireAuth(req: unknown, res: unknown, next: () => void) {
  next();
}
`,
  });

  const routeNames = ["users", "orders", "products", "payments", "invoices", "carts", "sessions", "notifications"];
  for (const r of routeNames) {
    files.push(route(r));
  }

  return files;
}
