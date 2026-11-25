import { Router } from 'express';
import { ctx } from '../../middleware/auth';
import { Attendance, ClassSection, LeaveRequest, Student, User, classLabel } from '../../models';
import { periodsNeedingCover } from '../../services/schedule';
import { todayISO } from '../../utils/dates';
import { ah, ok } from '../../utils/http';

/** A2: who is absent today, pending approvals and leave, today's attendance. */
const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const today = todayISO();

    const [teachersTotal, leavesToday, pendingTeachers, pendingLeaves, classes, studentsTotal, markedClassIds, absentToday, cover] =
      await Promise.all([
        User.countDocuments({ schoolId, role: 'teacher', status: 'approved' }),
        LeaveRequest.find({ schoolId, status: 'approved', from: { $lte: today }, to: { $gte: today } }).lean(),
        User.find({ schoolId, role: 'teacher', status: 'pending' }).sort({ createdAt: -1 }).limit(10).lean(),
        LeaveRequest.find({ schoolId, status: 'pending' }).sort({ from: 1 }).limit(10).lean(),
        ClassSection.find({ schoolId }).sort({ name: 1, section: 1 }).lean(),
        Student.countDocuments({ schoolId, active: true }),
        Attendance.distinct('classId', { schoolId, date: today }),
        Attendance.countDocuments({ schoolId, date: today, status: 'absent' }),
        periodsNeedingCover(schoolId, today),
      ]);

    const names = await User.find({
      _id: { $in: [...leavesToday.map((l) => l.teacherId), ...pendingLeaves.map((l) => l.teacherId)] },
    })
      .select('name')
      .lean();
    const nameOf = (id: { equals(o: unknown): boolean }) => names.find((n) => id.equals(n._id))?.name ?? '';
    const marked = new Set(markedClassIds.map(String));

    ok(res, {
      date: today,
      teachers: {
        total: teachersTotal,
        present: teachersTotal - new Set(leavesToday.map((l) => l.teacherId.toString())).size,
        onLeave: leavesToday.map((l) => ({ id: l.teacherId.toString(), name: nameOf(l.teacherId), type: l.type, from: l.from, to: l.to })),
      },
      approvals: {
        pendingTeachers: pendingTeachers.map((t) => ({ id: t._id.toString(), name: t.name, phone: t.phone })),
        pendingLeaves: pendingLeaves.map((l) => ({
          id: l._id.toString(),
          teacherName: nameOf(l.teacherId),
          type: l.type,
          from: l.from,
          to: l.to,
        })),
      },
      attendance: {
        studentsTotal,
        absent: absentToday,
        classesTotal: classes.length,
        classesMarked: classes.filter((c) => marked.has(c._id.toString())).length,
        unmarkedClasses: classes
          .filter((c) => !marked.has(c._id.toString()))
          .map((c) => ({ id: c._id.toString(), name: classLabel(c) })),
      },
      cover,
    });
  }),
);

export default router;
