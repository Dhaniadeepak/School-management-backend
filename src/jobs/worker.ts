import { Job, type IJob } from '../models';
import { handlers } from './handlers';
import type { HydratedDocument } from 'mongoose';

const STUCK_AFTER_MS = 5 * 60 * 1000;

async function runJob(job: HydratedDocument<IJob>): Promise<void> {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job.payload);
    job.status = 'done';
    job.doneAt = new Date();
  } catch (err) {
    job.lastError = err instanceof Error ? err.message : String(err);
    if (job.attempts >= job.maxAttempts) {
      job.status = 'failed';
      // eslint-disable-next-line no-console
      console.error(`[jobs] ${job.type} ${job._id.toString()} failed for good: ${job.lastError}`);
    } else {
      job.status = 'queued';
      job.runAt = new Date(Date.now() + 2 ** job.attempts * 15_000); // 30s, 1m, 2m, 4m...
    }
  }
  await job.save();
}

/** Polls the job collection. Safe to run in several server processes at once. */
export function startWorker(intervalMs = 2000): () => void {
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      // Put back jobs left "running" by a crashed process
      await Job.updateMany(
        { status: 'running', lockedAt: { $lt: new Date(Date.now() - STUCK_AFTER_MS) } },
        { $set: { status: 'queued' } },
      );
      for (let i = 0; i < 50 && !stopped; i++) {
        const job = await Job.findOneAndUpdate(
          { status: 'queued', runAt: { $lte: new Date() } },
          { $set: { status: 'running', lockedAt: new Date() }, $inc: { attempts: 1 } },
          { sort: { runAt: 1 }, new: true },
        );
        if (!job) break;
        await runJob(job);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] worker error', err);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
