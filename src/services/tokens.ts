import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';
import type { Role } from '../models';

export interface AccessClaims {
  sub: string;
  role: Role;
  schoolId: string;
  tv: number;
}

interface TokenUser {
  _id: { toString(): string };
  role: Role;
  schoolId: { toString(): string };
  tokenVersion: number;
}

export function signAccessToken(user: TokenUser): string {
  return jwt.sign({ role: user.role, schoolId: user.schoolId.toString(), tv: user.tokenVersion }, env.JWT_ACCESS_SECRET, {
    subject: user._id.toString(),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function signRefreshToken(user: TokenUser): string {
  const days = user.role === 'parent' ? env.REFRESH_TOKEN_TTL_DAYS_PARENT : env.REFRESH_TOKEN_TTL_DAYS_STAFF;
  return jwt.sign({ tv: user.tokenVersion, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    subject: user._id.toString(),
    expiresIn: days * 24 * 3600,
  });
}

export function issueTokens(user: TokenUser) {
  return { accessToken: signAccessToken(user), refreshToken: signRefreshToken(user) };
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
  return {
    sub: String(payload.sub),
    role: payload.role as Role,
    schoolId: String(payload.schoolId),
    tv: Number(payload.tv),
  };
}

export function verifyRefreshToken(token: string): { sub: string; tv: number } {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
  if (payload.typ !== 'refresh') throw new Error('Not a refresh token');
  return { sub: String(payload.sub), tv: Number(payload.tv) };
}
