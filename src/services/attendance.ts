import { Types } from 'mongoose';
import { enqueue } from '../jobs/queue';
import type { AuthContext } from '../middleware/auth';
import { Attendance, School, Student } from '../models';
import { addDays, todayISO } from '../utils/dates';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { audit } from './audit';

export type AttendanceStatus = 'present' | 'absent';

/** Students of a class with their attendance status for a date (default: present, not yet marked). */
export async function classAttendance(schoolId: Types.ObjectId, classId: Types.ObjectId, date: string) {
  const [students, records] = await Promise.all([
    Student.find({ schoolId, classId, active: true }).sort({ rollNo: 1, name: 1 }).lean(),
    Attendance.find({ schoolId, classId, date }).lean(),
  ]);
  const byStudent = new Map(records.map((r) => [r.studentId.toString(), r]));
  return {
    date,
    classId: classId.toString(),
    marked: records.length > 0,
    markedAt: records.reduce<Date | null>((latest, r) => (!latest || r.markedAt > latest ? r.markedAt : latest), null),
    students: students.map((s) => {
      const r = byStudent.get(s._id.toString());
      return {
        id: s._id.toString(),
        name: s.name,
        rollNo: s.rollNo ?? null,
        admissionNo: s.admissionNo,
        status: (r?.status ?? 'present') as AttendanceStatus,
        recorded: !!r,
      };
    }),
  };
}

/**
 * Saves a class's attendance for one date (one record per student per date, so a
 * repeated submit just overwrites). Teachers may only edit within the school's edit
 * window; admins can always correct. Every change to an existing record is audited, and
 * parents of newly absent students are alerted by a background job.
 */
export async function saveClassAttendance(
  who: AuthContext,
  classId: Types.ObjectId,
  date: string,
  statuses: Map<string, AttendanceStatus>,
): Promise<{ saved: number; newlyAbsent: number }> {
  const school = await School.findById(who.schoolId).select('settings').lean();
  if (!school) throw notFound('School not found');

  const today = todayISO();
  if (date > today) throw badRequest('Attendance cannot be marked for a future date');

  const windowHours = school.settings.attendanceEditWindowHours;
  if (who.role === 'teacher' && date < addDays(today, -Math.ceil(windowHours / 24))) {
    throw forbidden(`Attendance older than ${windowHours} hours can only be changed by the school office`);
  }

  const students = await Student.find({ schoolId: who.schoolId, classId, active: true }).select('_id').lean();
  const validIds = new Set(students.map((s) => s._id.toString()));
  for (const id of statuses.keys()) {
    if (!validIds.has(id)) throw badRequest('One or more students are not in this class');
  }

  const existing = await Attendance.find({ schoolId: who.schoolId, classId, date }).lean();
  const existingBy = new Map(existing.map((r) => [r.studentId.toString(), r]));

  if (who.role === 'teacher') {
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const tooOld = existing.find((r) => r.markedAt.getTime() < cutoff);
    if (tooOld) throw forbidden(`This attendance was submitted more than ${windowHours} hours ago. Ask the office to correct it.`);
  }

  const now = new Date();
  const newlyAbsent: Types.ObjectId[] = [];
  const ops: Parameters<typeof Attendance.bulkWrite>[0] = [];
  for (const s of students) {
    const id = s._id.toString();
    const status: AttendanceStatus = statuses.get(id) ?? 'present';
    const prev = existingBy.get(id);
    if (prev && prev.status === status) continue;

    if (status === 'absent' && prev?.status !== 'absent') newlyAbsent.push(s._id);
    if (prev) {
      ops.push({
        updateOne: {
          filter: { _id: prev._id },
          update: { $set: { status, editedBy: who.userId, editedAt: now } },
        },
      });
      await audit(who, 'attendance.edit', 'attendance', prev._id.toString(), { studentId: id, date, status: prev.status }, { studentId: id, date, status });
    } else {
      ops.push({
        updateOne: {
          filter: { schoolId: who.schoolId, studentId: s._id, date },
          update: {
            $setOnInsert: { schoolId: who.schoolId, studentId: s._id, date },
            $set: { classId, status, markedBy: who.userId, markedAt: now },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await Attendance.bulkWrite(ops, { ordered: false });

  if (newlyAbsent.length) {
    await enqueue('absence-alerts', {
      schoolId: who.schoolId.toString(),
      date,
      studentIds: newlyAbsent.map(String),
    });
  }
  return { saved: ops.length, newlyAbsent: newlyAbsent.length };
}
