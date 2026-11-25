import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { startWorker } from './jobs/worker';
import { initPush } from './services/push';

async function main() {
  await connectDB();
  initPush();
  const stopWorker = startWorker();

  const server = createApp().listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${env.PORT}/api/v1`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, shutting down`);
    stopWorker();
    server.close(() => {
      void disconnectDB().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
