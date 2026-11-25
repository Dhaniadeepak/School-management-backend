import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { enqueue } from '../../jobs/queue';
import { ctx } from '../../middleware/auth';
import { attachmentUpload } from '../../middleware/upload';
import { ClassSection, Homework, classLabel, type IAttachment } from '../../models';
import { assertTeacherClass, teacherClassIds } from '../../services/access';
import { deleteFile, saveFile, signedUrl } from '../../services/storage';
import { badRequest, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate, zId } from '../../utils/http';

/** T5: homework with optional photo/PDF attachments (10 MB each). */
const router = Router();

const MAX_FILES = 5;

const fields = z.object({
  classId: zId,
  subject: z.string().trim().min(1).max(40),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(4000).default(''),
  dueDate: zDate,
});

router.get(
  '/',
  ah(async (req, res) => {
    const who = ctx(req);
    const q = parse(z.object({ classId: zId.optional() }), req.query);
    const allowed = await teacherClassIds(who.schoolId, who.userId);
    const classFilter = q.classId ? allowed.filter((id) => id.toString() === q.classId) : allowed;
    const items = await Homework.find({ schoolId: who.schoolId, classId: { $in: classFilter } }).sort({ createdAt: -1 }).limit(100).lean();
    const classes = await ClassSection.find({ _id: { $in: classFilter } }).lean();
    ok(
      res,
      items.map((h) => ({
        id: h._id.toString(),
        classId: h.classId.toString(),
        className: classLabel(classes.find((c) => c._id.equals(h.classId))),
        subject: h.subject,
        title: h.title,
        description: h.description ?? '',
        dueDate: h.dueDate,
        mine: h.createdBy.equals(who.userId),
        attachments: h.attachments.map((a) => ({ key: a.key, name: a.name, mime: a.mime, size: a.size, url: signedUrl(a.key, 900, a.name) })),
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
      })),
    );
  }),
);

router.post(
  '/',
  attachmentUpload.array('attachments', MAX_FILES),
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(fields, req.body);
    const classId = new Types.ObjectId(b.classId);
    await assertTeacherClass(who.schoolId, who.userId, classId);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const attachments: IAttachment[] = [];
    for (const f of files) {
      attachments.push(await saveFile(f.buffer, { folder: `homework/${who.schoolId.toString()}`, originalName: f.originalname, mime: f.mimetype }));
    }
    const hw = await Homework.create({ schoolId: who.schoolId, ...b, classId, attachments, createdBy: who.userId });

    await enqueue('class-parents-notify', {
      schoolId: who.schoolId.toString(),
      classId: b.classId,
      type: 'homework',
      title: `New homework: ${b.subject}`,
      body: `${b.title} (due ${b.dueDate})`,
      data: { homeworkId: hw._id.toString() },
      dedupeKey: `homework:${hw._id.toString()}`,
    });
    ok(res, { id: hw._id.toString() }, 201);
  }),
);

/** Edit text and/or files; parents get an "updated" notice. */
router.patch(
  '/:id',
  attachmentUpload.array('attachments', MAX_FILES),
  ah(async (req, res) => {
    const who = ctx(req);
    const hw = await Homework.findOne({ _id: oid(req.params.id), schoolId: who.schoolId, createdBy: who.userId });
    if (!hw) throw notFound('Homework not found');

    const b = parse(
      fields.omit({ classId: true }).partial().extend({ removeKeys: z.string().optional() }),
      req.body,
    );
    if (b.subject !== undefined) hw.subject = b.subject;
    if (b.title !== undefined) hw.title = b.title;
    if (b.description !== undefined) hw.description = b.description;
    if (b.dueDate !== undefined) hw.dueDate = b.dueDate;

    let removeKeys: string[] = [];
    if (b.removeKeys) {
      try {
        removeKeys = z.array(z.string()).parse(JSON.parse(b.removeKeys));
      } catch {
        throw badRequest('removeKeys must be a JSON list');
      }
    }
    const kept: IAttachment[] = hw.attachments.filter((a) => !removeKeys.includes(a.key));
    for (const a of hw.attachments) if (removeKeys.includes(a.key)) await deleteFile(a.key);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (kept.length + files.length > MAX_FILES) throw badRequest(`At most ${MAX_FILES} attachments`);
    for (const f of files) {
      kept.push(await saveFile(f.buffer, { folder: `homework/${who.schoolId.toString()}`, originalName: f.originalname, mime: f.mimetype }));
    }
    hw.set('attachments', kept);
    await hw.save();

    await enqueue('class-parents-notify', {
      schoolId: who.schoolId.toString(),
      classId: hw.classId.toString(),
      type: 'homework_updated',
      title: `Homework updated: ${hw.subject}`,
      body: `${hw.title} (due ${hw.dueDate})`,
      data: { homeworkId: hw._id.toString() },
    });
    ok(res, { id: hw._id.toString() });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const who = ctx(req);
    const hw = await Homework.findOneAndDelete({ _id: oid(req.params.id), schoolId: who.schoolId, createdBy: who.userId });
    if (!hw) throw notFound('Homework not found');
    for (const a of hw.attachments) await deleteFile(a.key);
    ok(res, { deleted: true });
  }),
);

export default router;
