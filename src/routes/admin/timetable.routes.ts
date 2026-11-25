import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { ClassSection, LeaveRequest, School, Substitution, TimetableEntry, User, classLabel } from '../../models';
import { notifyUsers } from '../../services/notifications';
import { findDraftConflicts, periodsNeedingCover } from '../../services/schedule';
import { todayISO, weekdayOf } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate, zId } from '../../utils/http';

/**
 * A5: timetable builder. Admins edit a draft; "Publish" copies it into a new version that
 * teachers see. One-day substitutions override the published timetable for a date.
 */
const router = Router();

async function loadSchool(schoolId: Types.ObjectId) {
  const school = await School.findById(schoolId);
  if (!school) throw notFound('School not found');
  return school;
}

router.get(
  '/meta',
  ah(async (req, res) => {
    const school = await loadSchool(ctx(req).schoolId);
    const t = school.timetable;
    ok(res, {
      periods: school.settings.periods,
      workingDays: school.settings.workingDays,
      publishedVersion: t.publishedVersion,
      publishedAt: t.publishedAt ?? null,
      hasUnpublishedChanges: !!t.draftUpdatedAt && (!t.publishedAt || t.draftUpdatedAt > t.publishedAt),
    });
  }),
);

router.get(
  '/entries',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const q = parse(
      z.object({ teacherId: zId.optional(), classId: zId.optional(), status: z.enum(['draft', 'published']).default('draft') }),
      req.query,
    );
    if (!q.teacherId && !q.classId) throw badRequest('Choose a teacher or a class');
    const entries = await TimetableEntry.find({
      schoolId,
      status: q.status,
      ...(q.teacherId ? { teacherId: new Types.ObjectId(q.teacherId) } : {}),
      ...(q.classId ? { classId: new Types.ObjectId(q.classId) } : {}),
    }).lean();
    const [classes, teachers] = await Promise.all([
      ClassSection.find({ schoolId, _id: { $in: entries.map((e) => e.classId).filter(Boolean) } }).lean(),
      User.find({ schoolId, _id: { $in: entries.map((e) => e.teacherId) } }).select('name').lean(),
    ]);
    ok(
      res,
      entries.map((e) => ({
        id: e._id.toString(),
        teacherId: e.teacherId.toString(),
        teacherName: teachers.find((t) => t._id.equals(e.teacherId))?.name ?? '',
        day: e.day,
        period: e.period,
        kind: e.kind,
        classId: e.classId?.toString() ?? null,
        className: classLabel(classes.find((c) => e.classId && c._id.equals(e.classId))),
        subject: e.subject ?? '',
        room: e.room ?? '',
        note: e.note ?? '',
      })),
    );
  }),
);

const entryBody = z
  .object({
    teacherId: zId,
    day: z.number().int().min(1).max(7),
    period: z.number().int().min(1).max(20),
    kind: z.enum(['class', 'duty']),
    classId: zId.optional(),
    subject: z.string().trim().max(40).optional(),
    room: z.string().trim().max(20).optional(),
    note: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.kind !== 'class' || (!!v.classId && !!v.subject), {
    message: 'A teaching period needs a class and a subject',
  });

/** Sets one slot (teacher, day, period) in the draft, replacing whatever was there. */
router.put(
  '/entries',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const body = parse(entryBody, req.body);
    const school = await loadSchool(schoolId);

    if (!school.settings.workingDays.includes(body.day)) throw badRequest('That day is not a working day');
    if (!school.settings.periods.some((p) => p.number === body.period)) throw badRequest('That period does not exist');
    if (!(await User.exists({ _id: body.teacherId, schoolId, role: 'teacher', status: 'approved' }))) {
      throw badRequest('Teacher not found');
    }
    if (body.classId && !(await ClassSection.exists({ _id: body.classId, schoolId }))) throw badRequest('Class not found');

    const teacherId = new Types.ObjectId(body.teacherId);
    const classId = body.classId ? new Types.ObjectId(body.classId) : undefined;
    const current = await TimetableEntry.findOne({ schoolId, status: 'draft', teacherId, day: body.day, period: body.period });

    const conflicts = await findDraftConflicts(schoolId, { teacherId, day: body.day, period: body.period, kind: body.kind, classId }, current?._id);
    if (conflicts.length) throw conflict(conflicts.join('. '), { conflicts });

    const data = { kind: body.kind, classId, subject: body.subject, room: body.room, note: body.note };
    const entry = current
      ? Object.assign(current, data)
      : new TimetableEntry({ schoolId, status: 'draft', teacherId, day: body.day, period: body.period, ...data });
    await entry.save();

    school.timetable.draftUpdatedAt = new Date();
    await school.save();
    ok(res, { id: entry._id.toString() });
  }),
);

router.delete(
  '/entries/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const r = await TimetableEntry.deleteOne({ _id: oid(req.params.id), schoolId, status: 'draft' });
    if (r.deletedCount === 0) throw notFound('Draft entry not found');
    await School.updateOne({ _id: schoolId }, { $set: { 'timetable.draftUpdatedAt': new Date() } });
    ok(res, { deleted: true });
  }),
);

/** Publishes the draft as a new version and tells teachers. */
router.post(
  '/publish',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const school = await loadSchool(schoolId);
    const drafts = await TimetableEntry.find({ schoolId, status: 'draft' }).lean();
    if (drafts.length === 0) throw badRequest('The draft timetable is empty');

    const version = school.timetable.publishedVersion + 1;
    await TimetableEntry.updateMany({ schoolId, status: 'published' }, { $set: { status: 'archived' } });
    await TimetableEntry.insertMany(
      drafts.map((d) => {
        const { _id, ...rest } = d;
        void _id;
        return { ...rest, status: 'published', version };
      }),
    );
    school.timetable.publishedVersion = version;
    school.timetable.publishedAt = new Date();
    await school.save();

    const teacherIds = [...new Set(drafts.map((d) => d.teacherId.toString()))].map((id) => new Types.ObjectId(id));
    await notifyUsers({
      schoolId,
      userIds: teacherIds,
      type: 'timetable_published',
      title: 'Timetable updated',
      body: 'The school has published a new timetable. Open the app to see your periods.',
      data: { version: String(version) },
    });
    ok(res, { version, entries: drafts.length });
  }),
);

// ---------- One-day substitutions ----------
router.get(
  '/substitutions',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { date } = parse(z.object({ date: zDate.default(() => todayISO()) }), req.query);
    const subs = await Substitution.find({ schoolId, date }).sort({ period: 1 }).lean();
    const [classes, users] = await Promise.all([
      ClassSection.find({ schoolId, _id: { $in: subs.map((s) => s.classId) } }).lean(),
      User.find({ schoolId, _id: { $in: subs.flatMap((s) => [s.substituteTeacherId, s.originalTeacherId]).filter(Boolean) } })
        .select('name')
        .lean(),
    ]);
    const name = (id?: Types.ObjectId) => (id ? users.find((u) => u._id.equals(id))?.name ?? '' : '');
    ok(res, {
      date,
      items: subs.map((s) => ({
        id: s._id.toString(),
        period: s.period,
        classId: s.classId.toString(),
        className: classLabel(classes.find((c) => c._id.equals(s.classId))),
        substituteTeacherId: s.substituteTeacherId.toString(),
        substituteTeacherName: name(s.substituteTeacherId),
        originalTeacherName: name(s.originalTeacherId),
        subject: s.subject ?? '',
        room: s.room ?? '',
        note: s.note ?? '',
      })),
      needCover: await periodsNeedingCover(schoolId, date),
    });
  }),
);

router.post(
  '/substitutions',
  ah(async (req, res) => {
    const who = ctx(req);
    const body = parse(
      z.object({
        date: zDate,
        period: z.number().int().min(1).max(20),
        classId: zId,
        substituteTeacherId: zId,
        originalTeacherId: zId.optional(),
        subject: z.string().trim().max(40).optional(),
        room: z.string().trim().max(20).optional(),
        note: z.string().trim().max(120).optional(),
      }),
      req.body,
    );
    const schoolId = who.schoolId;
    const subId = new Types.ObjectId(body.substituteTeacherId);
    if (!(await User.exists({ _id: subId, schoolId, role: 'teacher', status: 'approved' }))) throw badRequest('Teacher not found');
    if (!(await ClassSection.exists({ _id: body.classId, schoolId }))) throw badRequest('Class not found');

    const onLeave = await LeaveRequest.exists({ schoolId, teacherId: subId, status: 'approved', from: { $lte: body.date }, to: { $gte: body.date } });
    if (onLeave) throw conflict('This teacher is on leave that day');
    const busy = await TimetableEntry.exists({ schoolId, status: 'published', teacherId: subId, day: weekdayOf(body.date), period: body.period, kind: 'class' });
    if (busy) throw conflict('This teacher is teaching another class in that period');

    const sub = await Substitution.create({
      schoolId,
      ...body,
      classId: new Types.ObjectId(body.classId),
      substituteTeacherId: subId,
      originalTeacherId: body.originalTeacherId ? new Types.ObjectId(body.originalTeacherId) : undefined,
      createdBy: who.userId,
    });
    const cls = await ClassSection.findById(body.classId).lean();
    await notifyUsers({
      schoolId,
      userIds: [subId],
      type: 'substitution',
      title: 'Cover assigned',
      body: `On ${body.date}, period ${body.period}: cover Class ${classLabel(cls)}${body.room ? `, Room ${body.room}` : ''}.`,
      data: { date: body.date },
    });
    ok(res, { id: sub._id.toString() }, 201);
  }),
);

router.delete(
  '/substitutions/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const r = await Substitution.deleteOne({ _id: oid(req.params.id), schoolId });
    if (r.deletedCount === 0) throw notFound('Substitution not found');
    ok(res, { deleted: true });
  }),
);

export default router;
