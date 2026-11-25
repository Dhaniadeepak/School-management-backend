import { Router } from 'express';
import path from 'path';
import { readFile, verifySignedUrl } from '../services/storage';
import { forbidden, notFound } from '../utils/errors';
import { ah } from '../utils/http';

/** Serves stored files only through signed, expiring links. */
const router = Router();

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

router.get(
  '/:key',
  ah(async (req, res) => {
    const key = req.params.key;
    const { exp, sig, name } = req.query as Record<string, string | undefined>;
    if (!exp || !sig || !verifySignedUrl(key, exp, sig)) throw forbidden('This link has expired. Please open it again from the app.');

    let data: Buffer;
    try {
      data = await readFile(key);
    } catch {
      throw notFound('File not found');
    }
    const ext = path.extname(key).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=600');
    const safeName = (name ?? path.basename(key)).replace(/[^\w.\- ]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.send(data);
  }),
);

export default router;
