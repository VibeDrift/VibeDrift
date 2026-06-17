import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

// ← DRIFT: Uses ORM (Prisma) instead of repository pattern
// Has auth, has camelCase — those are consistent

const prisma = new PrismaClient();

export function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

export async function createPayment(req: Request, res: Response) {
  try {
    const payment = await prisma.payment.create({
      data: {
        orderId: req.body.orderId,
        amount: req.body.amount,
        method: req.body.method,
      },
    });
    return res.status(201).json(payment);
  } catch (err) {
    console.log('Payment error:', err);
    // ← DRIFT: error swallowed (logged but not re-thrown)
  }
}

export async function getPayment(req: Request, res: Response) {
  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
  });
  if (!payment) return res.status(404).json({ error: 'Not found' });
  return res.json(payment);
}

export async function listPayments(req: Request, res: Response) {
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return res.json(payments);
}
