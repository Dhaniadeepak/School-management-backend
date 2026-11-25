import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { User, type Role, type UserStatus } from '../models';
import { verifyAccessToken } from '../services/tokens';
import { forbidden, unauthorized } from '../utils/errors';
import { ah } from '../utils/http';

export interface AuthContext {
  userId: Types.ObjectId;
  schoolId: Types.ObjectId;
  role: Role;
  status: UserStatus;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verifies the bearer token and loads the user on every request, so that a
 * deactivation or logout takes effect immediately.
 */
export const authenticate = ah(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  let claims;
  try {
    claims = verifyAccessToken(header.slice(7));
  } catch {
    throw unauthorized('Your session has expired');
  }

  const user = await User.findById(claims.sub).select('role schoolId status tokenVersion name').lean();
  if (!user || user.tokenVersion !== claims.tv) throw unauthorized('Your session has expired');
  if (user.status === 'deactivated') throw forbidden('This account has been deactivated');

  req.auth = {
    userId: user._id,
    schoolId: user.schoolId,
    role: user.role,
    status: user.status,
    name: user.name,
  };
  next();
});

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(forbidden());
    next();
  };

/** Teachers see no school data until the office approves them. */
export const requireApproved = (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth?.status !== 'approved') {
    return next(forbidden('Your account is waiting for approval from the school office'));
  }
  next();
};

/** Returns the signed-in user's context. Every query must filter on ctx.schoolId. */
export function ctx(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
