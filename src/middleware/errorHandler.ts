import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { isProd } from '../config/env';
import { AppError, isDuplicateKeyError } from '../utils/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (limit 10 MB)' : err.message;
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
  }
  if (isDuplicateKeyError(err)) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'This record already exists' } });
  }
  if (err instanceof mongoose.Error.CastError || err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({
    error: { code: 'SERVER_ERROR', message: isProd ? 'Something went wrong' : String(err?.message ?? err) },
  });
};
