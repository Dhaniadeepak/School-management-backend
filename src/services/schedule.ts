import { Types } from 'mongoose';
import {
  ClassSection,
  LeaveRequest,
  School,
  Substitution,
  TimetableEntry,
  User,
  classLabel,
  type IPeriod,
  type ITimetableEntry,
} from '../models';
import { weekdayOf } from '../utils/dates';
import { notFound } from '../utils/errors';

export type SlotKind = 'class' | 'duty' | 'free' | 'substitution' | 'covered';

export interface ScheduleSlot {
  period: number;
  start?: string;
  end?: string;
  kind: SlotKind;
  classId?: string;
  className?: string;
  subject?: string;
  room?: string;
  note?: string;
}

export interface DaySchedule {
  date: string;
  holiday?: string;
  onLeave: boolean;
  slots: ScheduleSlot[];
}

type ClassLite = { _id: Types.ObjectId; name: string; section: string };

async function classMap(schoolId: Types.ObjectId, ids: (Types.ObjectId | undefined)[]) {
  const list = await ClassSection.find({ schoolId, _id: { $in: ids.filter(Boolean) } })
    .select('name section')
    .lean<ClassLite[]>();
  return new Map(list.map((c) => [c._id.toString(), c]));
}

/** A teacher's periods for one date: published timetable + one-day substitutions + holidays + leave. */
export async function teacherDaySchedule(
  schoolId: Types.ObjectId,
  teacherId: Types.ObjectId,
  date: string,
): Promise<DaySchedule> {
  const school = await School.findById(schoolId).lean();
  if (!school) throw notFound('School not found');
  const day = weekdayOf(date);
  const periods: IPeriod[] = [...school.settings.periods].sort((a, b) => a.number - b.number);

  const holiday =
    school.holidays.find((h) => h.date === date)?.name ??
    (school.settings.workingDays.includes(day) ? undefined : 'Weekly off');

  const onLeave = !!(await LeaveRequest.exists({
    schoolId,
    teacherId,
    status: 'approved',
    from: { $lte: date },
    to: { $gte: date },
  }));

  if (holiday) return { date, holiday, onLeave, slots: [] };

  const [entries, covering, coveredForMe] = await Promise.all([
    TimetableEntry.find({ schoolId, status: 'published', teacherId, day }).lean(),
    Substitution.find({ schoolId, date, substituteTeacherId: teacherId }).lean(),
    Substitution.find({ schoolId, date, originalTeacherId: teacherId }).lean(),
  ]);
  const classes = await classMap(schoolId, [
    ...entries.map((e) => e.classId),
    ...covering.map((s) => s.classId),
    ...coveredForMe.map((s) => s.classId),
  ]);
  const cls = (id?: Types.ObjectId) => (id ? classes.get(id.toString()) : undefined);

  const slots: ScheduleSlot[] = periods.map((p) => {
    const base = { period: p.number, start: p.start, end: p.end };
    const sub = covering.find((s) => s.period === p.number);
    if (sub) {
      return {
        ...base,
        kind: 'substitution',
        classId: sub.classId.toString(),
        className: classLabel(cls(sub.classId)),
        subject: sub.subject,
        room: sub.room,
        note: sub.note,
      };
    }
    const replaced = coveredForMe.find((s) => s.period === p.number);
    const entry = entries.find((e) => e.period === p.number);
    if (replaced && entry?.kind === 'class') {
      return { ...base, kind: 'covered', classId: entry.classId?.toString(), className: classLabel(cls(entry.classId)), subject: entry.subject, note: 'Covered by another teacher today' };
    }
    if (!entry) return { ...base, kind: 'free' };
    return {
      ...base,
      kind: entry.kind,
      classId: entry.classId?.toString(),
      className: classLabel(cls(entry.classId)),
      subject: entry.subject,
      room: entry.room,
      note: entry.note,
    };
  });

  return { date, onLeave, slots };
}

/** Clashes for a draft entry: a teacher in two places, or a class with two teachers. */
export async function findDraftConflicts(
  schoolId: Types.ObjectId,
  entry: Pick<ITimetableEntry, 'teacherId' | 'day' | 'period' | 'kind' | 'classId'>,
  excludeId?: Types.ObjectId,
): Promise<string[]> {
  const conflicts: string[] = [];
  const base = { schoolId, status: 'draft' as const, day: entry.day, period: entry.period, ...(excludeId ? { _id: { $ne: excludeId } } : {}) };

  const teacherBusy = await TimetableEntry.findOne({ ...base, teacherId: entry.teacherId }).lean();
  if (teacherBusy) conflicts.push('This teacher already has something in this period');

  if (entry.kind === 'class' && entry.classId) {
    const classBusy = await TimetableEntry.findOne({ ...base, kind: 'class', classId: entry.classId }).lean();
    if (classBusy) {
      const other = await User.findById(classBusy.teacherId).select('name').lean();
      conflicts.push(`This class already has ${other?.name ?? 'another teacher'} in this period`);
    }
  }
  return conflicts;
}

/** Periods that need cover because a teacher is on approved leave on `date`. */
export async function periodsNeedingCover(schoolId: Types.ObjectId, date: string) {
  const day = weekdayOf(date);
  const leaves = await LeaveRequest.find({ schoolId, status: 'approved', from: { $lte: date }, to: { $gte: date } }).lean();
  if (leaves.length === 0) return [];

  const teacherIds = leaves.map((l) => l.teacherId);
  const [entries, subs, teachers] = await Promise.all([
    TimetableEntry.find({ schoolId, status: 'published', kind: 'class', day, teacherId: { $in: teacherIds } }).lean(),
    Substitution.find({ schoolId, date }).lean(),
    User.find({ _id: { $in: teacherIds } }).select('name').lean(),
  ]);
  const classes = await classMap(schoolId, entries.map((e) => e.classId));
  const subTeacherIds = subs.map((s) => s.substituteTeacherId);
  const subTeachers = await User.find({ _id: { $in: subTeacherIds } }).select('name').lean();

  return entries
    .sort((a, b) => a.period - b.period)
    .map((e) => {
      const sub = subs.find((s) => s.period === e.period && e.classId && s.classId.equals(e.classId));
      return {
        date,
        period: e.period,
        teacherId: e.teacherId.toString(),
        teacherName: teachers.find((t) => t._id.equals(e.teacherId))?.name ?? '',
        classId: e.classId?.toString(),
        className: classLabel(e.classId ? classes.get(e.classId.toString()) : undefined),
        subject: e.subject,
        room: e.room,
        coveredBy: sub ? subTeachers.find((t) => t._id.equals(sub.substituteTeacherId))?.name ?? 'Assigned' : null,
        substitutionId: sub?._id.toString() ?? null,
      };
    });
}
