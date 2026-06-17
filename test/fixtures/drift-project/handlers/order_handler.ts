import { Request, Response } from 'express';
import pg from 'pg';

// ← DRIFT: Uses raw SQL (not repository pattern)
// ← DRIFT: Uses snake_case (not camelCase)
// ← DRIFT: NO auth middleware
// ← DRIFT: NO input validation

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function create_order(req: Request, res: Response) {
  const { user_id, product_id, quantity } = req.body;

  const result = await pool.query(
    'INSERT INTO orders (user_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING *',
    [user_id, product_id, quantity]
  );

  // ← DRIFT: Inline currency formatting (duplicates utils/format.ts)
  const total_price = result.rows[0].total;
  const display_price = '$' + total_price.toFixed(2);

  return res.status(201).json({ ...result.rows[0], display_price });
}

export async function get_order(req: Request, res: Response) {
  const result = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  return res.json(result.rows[0]);
}

export async function list_orders(req: Request, res: Response) {
  const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  return res.json(result.rows);
}

export async function delete_order(req: Request, res: Response) {
  await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
  return res.status(204).send();
}
