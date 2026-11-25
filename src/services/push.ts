import fs from 'fs';
import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env';

let app: App | null = null;

/** Starts Firebase Cloud Messaging if a service account is configured. */
export function initPush(): void {
  const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) {
    // eslint-disable-next-line no-console
    console.log('[push] FIREBASE_SERVICE_ACCOUNT not set: push disabled (in-app notifications still work)');
    return;
  }
  const json = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  app = initializeApp({ credential: cert(JSON.parse(json)) });
}

export type PushResult = { status: 'sent' | 'failed' | 'skipped'; invalidTokens: string[] };

export async function sendPush(
  tokens: string[],
  message: { title: string; body: string; data?: Record<string, string> },
): Promise<PushResult> {
  if (!app || tokens.length === 0) return { status: 'skipped', invalidTokens: [] };

  const res = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title: message.title, body: message.body },
    data: message.data,
  });
  const invalidTokens = res.responses
    .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered' ? tokens[i] : null))
    .filter((t): t is string => t !== null);
  return { status: res.successCount > 0 ? 'sent' : 'failed', invalidTokens };
}
