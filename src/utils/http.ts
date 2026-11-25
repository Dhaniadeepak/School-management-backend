import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Types, isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { badRequest } from './errors';

/** Wraps an async route so thrown errors reach the error handler. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Validates input with a zod schema and returns the typed result, or throws a 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest('Some fields are missing or invalid', result.error.flatten());
  return result.data;
}

/** Converts a route parameter into an ObjectId, or throws a 400. */
export function oid(value: unknown, name = 'id'): Types.ObjectId {
  if (typeof value !== 'string' || !isValidObjectId(value)) throw badRequest(`Invalid ${name}`);
  return new Types.ObjectId(value);
}

export const zId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ data });
