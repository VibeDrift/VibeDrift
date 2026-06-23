// Fake async DB layer. Some callers await it, others use .then() chains.

const tables: Record<string, any[]> = {
  users: [],
  orders: [],
  invoices: [],
  sessions: [],
};

export function query(table: string, predicate: (row: any) => boolean): Promise<any[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const rows = (tables[table] || []).filter(predicate);
      resolve(rows);
    }, 1);
  });
}

export function insert(table: string, row: any): Promise<any> {
  return new Promise((resolve) => {
    setTimeout(() => {
      tables[table] = tables[table] || [];
      tables[table].push(row);
      resolve(row);
    }, 1);
  });
}

export default {
  query,
  insert,
};
