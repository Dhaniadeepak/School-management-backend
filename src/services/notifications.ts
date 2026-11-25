import { Types } from 'mongoose';
import { enqueue } from '../jobs/queue';
import { Notification, ParentStudent, Student, TimetableEntry, User } from '../models';

const PUSH_BATCH = 100;

export interface NotifyInput {
  schoolId: Types.ObjectId;
  userIds: Types.ObjectId[];
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Same key twice = only one notification (e.g. a teacher submitting attendance twice). */
  dedupeKey?: (userId: Types.ObjectId) => string;
}

/** Saves in-app notifications and queues push delivery. Returns how many were created. */
export async function notifyUsers(input: NotifyInput): Promise<number> {
  const unique = [...new Map(input.userIds.map((id) => [id.toString(), id])).values()];
  if (unique.length === 0) return 0;

  const docs = unique.map((userId) => ({
    schoolId: input.schoolId,
    userId,
    type: input.type,
    title: input.title,
    body: input.body,
    data: input.data,
    dedupeKey: input.dedupeKey?.(userId),
  }));

  let createdIds: Types.ObjectId[] = [];
  try {
    const created = await Notification.insertMany(docs, { ordered: false });
    createdIds = created.map((d) => d._id);
  } catch (err) {
    // Duplicate dedupe keys are expected; keep the ones that were inserted.
    const e = err as { insertedDocs?: { _id: Types.ObjectId }[]; writeErrors?: { code?: number; err?: { code?: number } }[] };
    const onlyDuplicates = (e.writeErrors ?? []).every((w) => (w.code ?? w.err?.code) === 11000);
    if (!onlyDuplicates) throw err;
    createdIds = (e.insertedDocs ?? []).map((d) => d._id);
  }

  for (let i = 0; i < createdIds.length; i += PUSH_BATCH) {
    await enqueue('push', { notificationIds: createdIds.slice(i, i + PUSH_BATCH).map(String) });
  }
  return createdIds.length;
}

export async function adminIds(schoolId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const admins = await User.find({ schoolId, role: 'admin', status: 'approved' }).select('_id').lean();
  return admins.map((a) => a._id);
}

export async function parentIdsOfStudents(schoolId: Types.ObjectId, studentIds: Types.ObjectId[]) {
  const links = await ParentStudent.find({ schoolId, studentId: { $in: studentIds } }).lean();
  return links;
}

/** Users who should receive an announcement for the given audience. */
export async function audienceUserIds(
  schoolId: Types.ObjectId,
  audience: { kind: string; classIds: Types.ObjectId[] },
): Promise<Types.ObjectId[]> {
  const ids: Types.ObjectId[] = [];

  if (audience.kind === 'all' || audience.kind === 'teachers') {
    const teachers = await User.find({ schoolId, role: 'teacher', status: 'approved' }).select('_id').lean();
    ids.push(...teachers.map((t) => t._id));
  }
  if (audience.kind === 'all' || audience.kind === 'parents') {
    const parents = await User.find({ schoolId, role: 'parent', status: 'approved' }).select('_id').lean();
    ids.push(...parents.map((p) => p._id));
  }
  if (audience.kind === 'classes' && audience.classIds.length) {
    const students = await Student.find({ schoolId, classId: { $in: audience.classIds }, active: true })
      .select('_id')
      .lean();
    const links = await ParentStudent.find({ schoolId, studentId: { $in: students.map((s) => s._id) } }).lean();
    ids.push(...links.map((l) => l.parentId));
    const teacherIds = (await TimetableEntry.distinct('teacherId', {
      schoolId,
      status: 'published',
      classId: { $in: audience.classIds },
    })) as Types.ObjectId[];
    ids.push(...teacherIds);
  }
  return ids;
}
