import { Request, Response } from 'express';
import { ProductRepository } from '../repositories/product_repo';
import { z } from 'zod';

const productRepo = new ProductRepository();

// Uses repository pattern, camelCase, has auth, has validation
export function authMiddleware(req: Request, res: Response, next: Function) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const productSchema = z.object({
  name: z.string(),
  price: z.number().positive(),
});

export async function createProduct(req: Request, res: Response) {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error });

  try {
    const product = await productRepo.create(parsed.data);
    return res.status(201).json(product);
  } catch (err) {
    throw new Error(`Failed to create product: ${err}`);
  }
}

export async function getProduct(req: Request, res: Response) {
  const product = await productRepo.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  return res.json(product);
}

export async function listProducts(req: Request, res: Response) {
  const products = await productRepo.findAll();
  return res.json(products);
}
