import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, ctx, requireApproved, requireRole } from '../../middleware/auth';
import { Announcement, ClassSection, LeaveRequest, Notification, classLabel } from '../../models';
import { classAttendance, saveClassAttendance, type AttendanceStatus } from '../../services/attendance';
import { assertTeacherClass, teacherClassIds } from '../../services/access';
import { teacherDaySchedule } from '../../services/schedule';
import { hhmmToMinutes, nowMinutes, todayISO } from '../../utils/dates';
import { ah, oid, ok, parse, zDate, zId } from '../../utils/http';
import homework from './homework.routes';
import leave from './leave.routes';

/** Teacher app API. Nothing here is reachable until the office approves the teacher. */
const router = Router();
router.use(authenticate, requireRole('teacher'), requireApproved);

router.use('/homework', homework);
router.use('/leave', leave);

/** T3: today's periods, the current one, free periods with their duty. */
router.get(
  '/dashboard',
  ah(async (req, res) => {
    const who = ctx(req);
    const { date } = parse(z.object({ date: zDate.default(() => todayISO()) }), req.query);
    const [schedule, unread, pendingLeave] = await Promise.all([
      teacherDaySchedule(who.schoolId, who.userId, date),
      Notification.countDocuments({ userId: who.userId, read: false }),
      LeaveRequest.countDocuments({ schoolId: who.schoolId, teacherId: who.userId, status: 'pending' }),
    ]);
    let currentPeriod: number | null = null;
    if (date === todayISO()) {
      const now = nowMinutes();
      currentPeriod =
        schedule.slots.find((s) => s.start && s.end && hhmmToMinutes(s.start) <= now && now < hhmmToMinutes(s.end))?.period ?? null;
    }
    ok(res, { ...schedule, currentPeriod, unreadNotifications: unread, pendingLeave, name: who.name });
  }),
);

/** Classes this teacher may take attendance for and post homework to. */
router.get(
  '/classes',
  ah(async (req, res) => {
    const who = ctx(req);
    const ids = await teacherClassIds(who.schoolId, who.userId);
    const classes = await ClassSection.find({ schoolId: who.schoolId, _id: { $in: ids } }).lean();
    ok(
      res,
      classes
        .map((c) => ({ id: c._id.toString(), label: classLabel(c), isClassTeacher: !!c.classTeacherId?.equals(who.userId) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    );
  }),
);

// ---------- T4: attendance ----------
router.get(
  '/attendance',
  ah(async (req, res) => {
    const who = ctx(req);
    const q = parse(z.object({ classId: zId, date: zDate.default(() => todayISO()) }), req.query);
    const classId = new Types.ObjectId(q.classId);
    await assertTeacherClass(who.schoolId, who.userId, classId);
    ok(res, await classAttendance(who.schoolId, classId, q.date));
  }),
);

/**
 * Everyone is present unless listed in absentStudentIds. Submitting twice is safe: records are
 * per student per date, and absence alerts are de-duplicated.
 */
router.post(
  '/attendance',
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(
      z.object({ classId: zId, date: zDate, absentStudentIds: z.array(zId).max(500), clientSubmissionId: z.string().max(64).optional() }),
      req.body,
    );
    const classId = new Types.ObjectId(b.classId);
    await assertTeacherClass(who.schoolId, who.userId, classId);
    const statuses = new Map<string, AttendanceStatus>(b.absentStudentIds.map((id) => [id, 'absent']));
    const result = await saveClassAttendance(who, classId, b.date, statuses);
    ok(res, { ...result, clientSubmissionId: b.clientSubmissionId ?? null });
  }),
);

// ---------- Announcements and events (view) ----------
router.get(
  '/announcements',
  ah(async (req, res) => {
    const who = ctx(req);
    const classIds = await teacherClassIds(who.schoolId, who.userId);
    const items = await Announcement.find({
      schoolId: who.schoolId,
      status: 'published',
      $or: [{ 'audience.kind': { $in: ['all', 'teachers'] } }, { 'audience.kind': 'classes', 'audience.classIds': { $in: classIds } }],
    })
      .sort({ publishAt: -1 })
      .limit(100)
      .lean();
    ok(
      res,
      items.map((a) => ({ id: a._id.toString(), kind: a.kind, title: a.title, body: a.body, event: a.event?.date ? a.event : null, publishAt: a.publishAt })),
    );
  }),
);

router.get(
  '/announcements/:id',
  ah(async (req, res) => {
    const who = ctx(req);
    const a = await Announcement.findOne({ _id: oid(req.params.id), schoolId: who.schoolId, status: 'published' }).lean();
    ok(res, a ? { id: a._id.toString(), kind: a.kind, title: a.title, body: a.body, event: a.event?.date ? a.event : null, publishAt: a.publishAt } : null);
  }),
);

export default router;
