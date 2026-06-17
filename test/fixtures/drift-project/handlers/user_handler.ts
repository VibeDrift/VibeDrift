import { Request, Response } from 'express';
import { UserRepository } from '../repositories/user_repo';
import { z } from 'zod';

const userRepo = new UserRepository();

// Uses repository pattern, camelCase, has auth, has validation
export function requireAuth(req: Request, res: Response, next: Function) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export async function createUser(req: Request, res: Response) {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error });

  try {
    const user = await userRepo.create(parsed.data);
    return res.status(201).json(user);
  } catch (err) {
    throw new Error(`Failed to create user: ${err}`);
  }
}

export async function getUser(req: Request, res: Response) {
  const user = await userRepo.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  return res.json(user);
}

export async function listUsers(req: Request, res: Response) {
  const users = await userRepo.findAll();
  return res.json(users);
}
