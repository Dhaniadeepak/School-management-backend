import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { Attendance, ClassSection, Student, classLabel } from '../../models';
import { classAttendance, saveClassAttendance, type AttendanceStatus } from '../../services/attendance';
import { todayISO } from '../../utils/dates';
import { badRequest } from '../../utils/errors';
import { ah, ok, parse, zDate, zId } from '../../utils/http';

/** Admin view and correction of attendance (teachers' edits close after the edit window). */
const router = Router();

router.get(
  '/summary',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { date } = parse(z.object({ date: zDate.default(() => todayISO()) }), req.query);
    const [classes, totals, records] = await Promise.all([
      ClassSection.find({ schoolId }).lean(),
      Student.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { schoolId, active: true } },
        { $group: { _id: '$classId', n: { $sum: 1 } } },
      ]),
      Attendance.aggregate<{ _id: Types.ObjectId; marked: number; absent: number }>([
        { $match: { schoolId, date } },
        { $group: { _id: '$classId', marked: { $sum: 1 }, absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } } } },
      ]),
    ]);
    ok(res, {
      date,
      classes: classes
        .map((c) => {
          const r = records.find((x) => x._id.equals(c._id));
          return {
            classId: c._id.toString(),
            className: classLabel(c),
            students: totals.find((t) => t._id.equals(c._id))?.n ?? 0,
            marked: !!r,
            absent: r?.absent ?? 0,
          };
        })
        .sort((a, b) => a.className.localeCompare(b.className, undefined, { numeric: true })),
    });
  }),
);

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const q = parse(z.object({ classId: zId, date: zDate.default(() => todayISO()) }), req.query);
    const classId = new Types.ObjectId(q.classId);
    if (!(await ClassSection.exists({ _id: classId, schoolId }))) throw badRequest('Class not found');
    ok(res, await classAttendance(schoolId, classId, q.date));
  }),
);

router.put(
  '/',
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(
      z.object({
        classId: zId,
        date: zDate,
        records: z.array(z.object({ studentId: zId, status: z.enum(['present', 'absent']) })).max(500),
      }),
      req.body,
    );
    const classId = new Types.ObjectId(b.classId);
    if (!(await ClassSection.exists({ _id: classId, schoolId: who.schoolId }))) throw badRequest('Class not found');
    const statuses = new Map<string, AttendanceStatus>(b.records.map((r) => [r.studentId, r.status]));
    ok(res, await saveClassAttendance(who, classId, b.date, statuses));
  }),
);

export default router;
