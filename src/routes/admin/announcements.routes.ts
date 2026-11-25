import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { enqueue } from '../../jobs/queue';
import { ctx } from '../../middleware/auth';
import { Announcement, ClassSection, User, classLabel } from '../../models';
import { badRequest, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate, zId, zTime } from '../../utils/http';

/** A7: notices and events with audience and optional scheduled publishing. */
const router = Router();

const body = z
  .object({
    kind: z.enum(['notice', 'event']),
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().max(4000).default(''),
    audience: z.object({
      kind: z.enum(['all', 'teachers', 'parents', 'classes']),
      classIds: z.array(zId).default([]),
    }),
    event: z.object({ date: zDate, time: zTime.optional(), place: z.string().trim().max(120).optional() }).optional(),
    publishAt: z.coerce.date().optional(),
  })
  .refine((v) => v.kind !== 'event' || !!v.event, { message: 'An event needs a date' })
  .refine((v) => v.audience.kind !== 'classes' || v.audience.classIds.length > 0, { message: 'Choose at least one class' });

async function assertClasses(schoolId: Types.ObjectId, ids: string[]) {
  if (!ids.length) return;
  const n = await ClassSection.countDocuments({ schoolId, _id: { $in: ids } });
  if (n !== ids.length) throw badRequest('One or more classes were not found');
}

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const items = await Announcement.find({ schoolId }).sort({ publishAt: -1 }).limit(200).lean();
    const classes = await ClassSection.find({ schoolId }).lean();
    const authors = await User.find({ _id: { $in: items.map((a) => a.createdBy) } }).select('name').lean();
    ok(
      res,
      items.map((a) => ({
        id: a._id.toString(),
        kind: a.kind,
        title: a.title,
        body: a.body,
        audience: {
          kind: a.audience.kind,
          classIds: a.audience.classIds.map(String),
          classNames: a.audience.classIds.map((id) => classLabel(classes.find((c) => c._id.equals(id)))),
        },
        event: a.event?.date ? a.event : null,
        publishAt: a.publishAt,
        status: a.status,
        createdBy: authors.find((u) => u._id.equals(a.createdBy))?.name ?? '',
      })),
    );
  }),
);

router.post(
  '/',
  ah(async (req, res) => {
    const who = ctx(req);
    const data = parse(body, req.body);
    await assertClasses(who.schoolId, data.audience.classIds);
    const publishAt = data.publishAt && data.publishAt > new Date() ? data.publishAt : new Date();
    const scheduled = publishAt > new Date(Date.now() + 1000);

    const ann = await Announcement.create({
      schoolId: who.schoolId,
      ...data,
      audience: { kind: data.audience.kind, classIds: data.audience.classIds.map((id) => new Types.ObjectId(id)) },
      publishAt,
      status: scheduled ? 'scheduled' : 'published',
      createdBy: who.userId,
    });
    await enqueue('announcement-publish', { announcementId: ann._id.toString(), notifyNow: !scheduled }, { runAt: publishAt });
    ok(res, { id: ann._id.toString(), status: ann.status }, 201);
  }),
);

router.patch(
  '/:id',
  ah(async (req, res) => {
    const who = ctx(req);
    const data = parse(body, req.body);
    await assertClasses(who.schoolId, data.audience.classIds);
    const ann = await Announcement.findOne({ _id: oid(req.params.id), schoolId: who.schoolId });
    if (!ann) throw notFound('Announcement not found');

    ann.kind = data.kind;
    ann.title = data.title;
    ann.body = data.body;
    ann.audience = { kind: data.audience.kind, classIds: data.audience.classIds.map((id) => new Types.ObjectId(id)) };
    ann.event = data.event;
    if (ann.status === 'scheduled' && data.publishAt) {
      ann.publishAt = data.publishAt > new Date() ? data.publishAt : new Date();
      await enqueue('announcement-publish', { announcementId: ann._id.toString() }, { runAt: ann.publishAt });
    }
    await ann.save();
    ok(res, { id: ann._id.toString(), status: ann.status });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const r = await Announcement.deleteOne({ _id: oid(req.params.id), schoolId });
    if (r.deletedCount === 0) throw notFound('Announcement not found');
    ok(res, { deleted: true });
  }),
);

export default router;
