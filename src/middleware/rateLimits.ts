import rateLimit from 'express-rate-limit';

const message = { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait and try again.' } };

/** Login, OTP and password reset endpoints. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

/** Everything else. Generous, because attendance time is a peak. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});
