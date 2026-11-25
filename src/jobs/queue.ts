import { Job, type JobType } from '../models';

/** Adds a background job. Notifications and PDFs are never produced inside a request. */
export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await Job.create({ type, payload, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5 });
}
