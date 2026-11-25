export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, message, 'BAD_REQUEST', details);
export const unauthorized = (message = 'Please sign in again') => new AppError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'You are not allowed to do this') => new AppError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Not found') => new AppError(404, message, 'NOT_FOUND');
export const conflict = (message: string, details?: unknown) => new AppError(409, message, 'CONFLICT', details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, message, 'VALIDATION_FAILED', details);
export const tooMany = (message: string) => new AppError(429, message, 'TOO_MANY_REQUESTS');

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
