import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/school_app'),
  TIMEZONE: z.string().default('Asia/Kolkata'),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me-please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me-please'),
  OTP_SECRET: z.string().min(16).default('dev-otp-secret-change-me-please'),
  FILE_URL_SECRET: z.string().min(16).default('dev-file-secret-change-me-please'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS_STAFF: z.coerce.number().default(7),
  REFRESH_TOKEN_TTL_DAYS_PARENT: z.coerce.number().default(90),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5175'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  UPLOAD_DIR: z.string().default('./uploads'),

  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  PAYMENTS_MOCK: bool,

  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

if (isProd) {
  const weak = (['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_SECRET', 'FILE_URL_SECRET'] as const).filter(
    (k) => env[k].startsWith('dev-'),
  );
  if (weak.length) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
    process.exit(1);
  }
  if (env.PAYMENTS_MOCK) {
    // eslint-disable-next-line no-console
    console.error('PAYMENTS_MOCK must be false in production');
    process.exit(1);
  }
}
