import { Types } from 'mongoose';
import { Announcement, ClassSection, Notification, Student, User, classLabel, type JobType } from '../models';
import { audienceUserIds, notifyUsers, parentIdsOfStudents } from '../services/notifications';
import { sendPush } from '../services/push';
import { generateReceipt } from '../services/receipts';

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const toIds = (v: unknown): Types.ObjectId[] =>
  Array.isArray(v) ? v.map((x) => new Types.ObjectId(String(x))) : [];

/** Tell every linked guardian that their child was marked absent. Safe to run twice. */
const absenceAlerts: Handler = async (p) => {
  const schoolId = new Types.ObjectId(String(p.schoolId));
  const date = String(p.date);
  const studentIds = toIds(p.studentIds);
  const [students, links] = await Promise.all([
    Student.find({ _id: { $in: studentIds }, schoolId }).lean(),
    parentIdsOfStudents(schoolId, studentIds),
  ]);
  const classIds = [...new Set(students.map((s) => s.classId.toString()))];
  const classes = await ClassSection.find({ _id: { $in: classIds } }).lean();

  for (const s of students) {
    const parentIds = links.filter((l) => l.studentId.equals(s._id)).map((l) => l.parentId);
    const cls = classes.find((c) => c._id.equals(s.classId));
    await notifyUsers({
      schoolId,
      userIds: parentIds,
      type: 'absence',
      title: 'Absence alert',
      body: `${s.name} (Class ${classLabel(cls)}) was marked absent on ${date}.`,
      data: { studentId: s._id.toString(), date },
      dedupeKey: (uid) => `absence:${s._id.toString()}:${date}:${uid.toString()}`,
    });
  }
};

/** Deliver queued notifications by Firebase push and record the outcome. */
const push: Handler = async (p) => {
  const ids = toIds(p.notificationIds);
  const notes = await Notification.find({ _id: { $in: ids }, deliveryStatus: 'queued' }).lean();
  const users = await User.find({ _id: { $in: notes.map((n) => n.userId) } }).select('fcmTokens').lean();

  for (const n of notes) {
    const tokens = users.find((u) => u._id.equals(n.userId))?.fcmTokens ?? [];
    const result = await sendPush(tokens, { title: n.title, body: n.body, data: n.data });
    await Notification.updateOne({ _id: n._id }, { $set: { deliveryStatus: result.status } });
    if (result.invalidTokens.length) {
      await User.updateOne({ _id: n.userId }, { $pull: { fcmTokens: { $in: result.invalidTokens } } });
    }
  }
};

/** Publishes a scheduled announcement (if still due) and notifies its audience. */
const announcementPublish: Handler = async (p) => {
  const ann = await Announcement.findById(String(p.announcementId));
  if (!ann) return;
  if (ann.status === 'scheduled') {
    if (ann.publishAt > new Date()) return; // rescheduled later; a newer job will handle it
    ann.status = 'published';
    await ann.save();
  } else if (!p.notifyNow) {
    return;
  }
  const userIds = await audienceUserIds(ann.schoolId, ann.audience);
  await notifyUsers({
    schoolId: ann.schoolId,
    userIds,
    type: ann.kind === 'event' ? 'event' : 'announcement',
    title: ann.kind === 'event' ? `New event: ${ann.title}` : ann.title,
    body: ann.kind === 'event' && ann.event?.date ? `${ann.event.date}${ann.event.time ? ` at ${ann.event.time}` : ''}${ann.event.place ? `, ${ann.event.place}` : ''}` : ann.body.slice(0, 140),
    data: { announcementId: ann._id.toString() },
    dedupeKey: (uid) => `announcement:${ann._id.toString()}:${uid.toString()}`,
  });
};

const receiptPdf: Handler = async (p) => {
  await generateReceipt(new Types.ObjectId(String(p.paymentId)));
};

/** Notify the parents of every student in a class (e.g. new or edited homework). */
const classParentsNotify: Handler = async (p) => {
  const schoolId = new Types.ObjectId(String(p.schoolId));
  const students = await Student.find({ schoolId, classId: String(p.classId), active: true }).select('_id').lean();
  const links = await parentIdsOfStudents(schoolId, students.map((s) => s._id));
  const key = p.dedupeKey ? String(p.dedupeKey) : undefined;
  await notifyUsers({
    schoolId,
    userIds: links.map((l) => l.parentId),
    type: String(p.type),
    title: String(p.title),
    body: String(p.body ?? ''),
    data: (p.data as Record<string, string>) ?? {},
    dedupeKey: key ? (uid) => `${key}:${uid.toString()}` : undefined,
  });
};

export const handlers: Record<JobType, Handler> = {
  'absence-alerts': absenceAlerts,
  push,
  'announcement-publish': announcementPublish,
  'receipt-pdf': receiptPdf,
  'class-parents-notify': classParentsNotify,
};
