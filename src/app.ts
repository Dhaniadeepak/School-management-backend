import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { corsOrigins, env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimits';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth.routes';
import fileRoutes from './routes/files.routes';
import meRoutes from './routes/me.routes';
import parentRoutes from './routes/parent';
import teacherRoutes from './routes/teacher';
import webhookRoutes from './routes/webhooks.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: corsOrigins, credentials: false }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Webhooks need the raw body for signature checks, so they come before express.json().
  app.use('/api/v1/webhooks', webhookRoutes);

  app.use(express.json({ limit: '1mb' }));
  app.get('/api/v1/health', (_req, res) => res.json({ data: { ok: true, time: new Date().toISOString() } }));

  app.use('/api/v1/files', fileRoutes);
  app.use('/api/v1', apiLimiter);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/me', meRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/teacher', teacherRoutes);
  app.use('/api/v1/parent', parentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
