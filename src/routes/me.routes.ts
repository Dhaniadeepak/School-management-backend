import { Router } from 'express';
import { z } from 'zod';
import { authenticate, ctx } from '../middleware/auth';
import { Notification, User } from '../models';
import { notFound } from '../utils/errors';
import { ah, oid, ok, parse } from '../utils/http';
import { publicUser } from './auth.routes';

/** Routes for any signed-in user: profile, notification list, device tokens. */
const router = Router();
router.use(authenticate);

router.get(
  '/',
  ah(async (req, res) => {
    const user = await User.findById(ctx(req).userId);
    if (!user) throw notFound();
    ok(res, await publicUser(user));
  }),
);

router.get(
  '/notifications',
  ah(async (req, res) => {
    const { userId } = ctx(req);
    const q = parse(z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().min(1).max(100).default(50) }), req.query);
    const filter = { userId, ...(q.unread === 'true' ? { read: false } : {}) };
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean(),
      Notification.countDocuments({ userId, read: false }),
    ]);
    ok(res, {
      unreadCount,
      items: items.map((n) => ({
        id: n._id.toString(),
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data ?? {},
        read: n.read,
        createdAt: n.createdAt,
      })),
    });
  }),
);

router.post(
  '/notifications/:id/read',
  ah(async (req, res) => {
    await Notification.updateOne({ _id: oid(req.params.id), userId: ctx(req).userId }, { $set: { read: true, readAt: new Date() } });
    ok(res, { read: true });
  }),
);

router.post(
  '/notifications/read-all',
  ah(async (req, res) => {
    await Notification.updateMany({ userId: ctx(req).userId, read: false }, { $set: { read: true, readAt: new Date() } });
    ok(res, { read: true });
  }),
);

/** Firebase device token for push notifications (sent by the app after login). */
router.post(
  '/devices',
  ah(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(4096) }), req.body);
    await User.updateOne({ _id: ctx(req).userId }, { $addToSet: { fcmTokens: token } });
    ok(res, { registered: true });
  }),
);

router.delete(
  '/devices',
  ah(async (req, res) => {
    const { token } = parse(z.object({ token: z.string() }), req.body);
    await User.updateOne({ _id: ctx(req).userId }, { $pull: { fcmTokens: token } });
    ok(res, { removed: true });
  }),
);

export default router;
