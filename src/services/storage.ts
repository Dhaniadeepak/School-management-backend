import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import type { IAttachment } from '../models';

/**
 * Local-disk file storage with expiring signed links.
 * To move to S3 / GCS, keep these function signatures and swap the implementation
 * (signedUrl would then return the provider's presigned URL).
 */
const root = path.resolve(env.UPLOAD_DIR);

function resolveKey(key: string): string {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid file key');
  return full;
}

export async function saveFile(
  buffer: Buffer,
  opts: { folder: string; originalName: string; mime: string },
): Promise<IAttachment> {
  const ext = path.extname(opts.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const month = new Date().toISOString().slice(0, 7);
  const key = `${opts.folder}/${month}/${crypto.randomUUID()}${ext}`;
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return { key, name: opts.originalName, mime: opts.mime, size: buffer.length };
}

export async function readFile(key: string): Promise<Buffer> {
  return fs.readFile(resolveKey(key));
}

export async function deleteFile(key: string): Promise<void> {
  await fs.rm(resolveKey(key), { force: true });
}

const sign = (key: string, exp: number) =>
  crypto.createHmac('sha256', env.FILE_URL_SECRET).update(`${key}:${exp}`).digest('hex');

/** A link that works for `ttlSeconds` (default 15 minutes) without a login. */
export function signedUrl(key: string, ttlSeconds = 15 * 60, downloadName?: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const url = new URL(`${env.PUBLIC_API_URL}/api/v1/files/${encodeURIComponent(key)}`);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sign(key, exp));
  if (downloadName) url.searchParams.set('name', downloadName);
  return url.toString();
}

export function verifySignedUrl(key: string, exp: string, sig: string): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(key, expNum));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export const withUrls = (files: IAttachment[]) =>
  files.map((f) => ({ name: f.name, mime: f.mime, size: f.size, url: signedUrl(f.key, 15 * 60, f.name) }));
