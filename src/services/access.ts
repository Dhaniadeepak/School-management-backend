import { Types } from 'mongoose';
import { ClassSection, ParentStudent, Student, Substitution, TimetableEntry } from '../models';
import { todayISO } from '../utils/dates';
import { forbidden, notFound } from '../utils/errors';

const uniqIds = (ids: Types.ObjectId[]) => [...new Map(ids.map((i) => [i.toString(), i])).values()];

/**
 * Classes a teacher may work with: classes in their published timetable, classes they are
 * class teacher of, and classes they cover today (duty or one-day substitution).
 */
export async function teacherClassIds(
  schoolId: Types.ObjectId,
  teacherId: Types.ObjectId,
  date = todayISO(),
): Promise<Types.ObjectId[]> {
  const [timetable, classTeacher, subs] = await Promise.all([
    TimetableEntry.distinct('classId', { schoolId, status: 'published', teacherId, classId: { $ne: null } }),
    ClassSection.distinct('_id', { schoolId, classTeacherId: teacherId }),
    Substitution.distinct('classId', { schoolId, date, substituteTeacherId: teacherId }),
  ]);
  return uniqIds([...timetable, ...classTeacher, ...subs] as Types.ObjectId[]);
}

export async function assertTeacherClass(
  schoolId: Types.ObjectId,
  teacherId: Types.ObjectId,
  classId: Types.ObjectId,
): Promise<void> {
  const ids = await teacherClassIds(schoolId, teacherId);
  if (!ids.some((id) => id.equals(classId))) throw forbidden('You are not assigned to this class');
}

/** Children linked to a parent account. */
export async function parentStudentIds(schoolId: Types.ObjectId, parentId: Types.ObjectId): Promise<Types.ObjectId[]> {
  return (await ParentStudent.distinct('studentId', { schoolId, parentId })) as Types.ObjectId[];
}

/**
 * Loads a student only if this parent is linked to them. Returns 404 (not 403) so that
 * guessing IDs reveals nothing.
 */
export async function loadParentChild(schoolId: Types.ObjectId, parentId: Types.ObjectId, studentId: Types.ObjectId) {
  const link = await ParentStudent.exists({ schoolId, parentId, studentId });
  if (!link) throw notFound('Child not found');
  const student = await Student.findOne({ _id: studentId, schoolId }).lean();
  if (!student) throw notFound('Child not found');
  return student;
}
