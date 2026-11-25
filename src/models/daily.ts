import { Schema, Types, model } from 'mongoose';

// ---------- Attendance (daily mode: one record per student per date) ----------
export interface IAttendance {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  classId: Types.ObjectId;
  date: string;
  status: 'present' | 'absent';
  markedBy: Types.ObjectId;
  markedAt: Date;
  editedBy?: Types.ObjectId;
  editedAt?: Date;
}

const attendanceSchema = new Schema<IAttendance>({
  schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
  classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['present', 'absent'], required: true },
  markedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  markedAt: { type: Date, required: true },
  editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  editedAt: Date,
});
attendanceSchema.index({ schoolId: 1, studentId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ schoolId: 1, classId: 1, date: 1 });
attendanceSchema.index({ schoolId: 1, date: 1, status: 1 });

export const Attendance = model<IAttendance>('Attendance', attendanceSchema);

// ---------- Homework ----------
export interface IAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
}

export const attachmentSchema = new Schema<IAttachment>(
  { key: String, name: String, mime: String, size: Number },
  { _id: false },
);

export interface IHomework {
  schoolId: Types.ObjectId;
  classId: Types.ObjectId;
  subject: string;
  title: string;
  description?: string;
  dueDate: string;
  attachments: IAttachment[];
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const homeworkSchema = new Schema<IHomework>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    subject: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    dueDate: { type: String, required: true },
    attachments: { type: [attachmentSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
homeworkSchema.index({ schoolId: 1, classId: 1, createdAt: -1 });

export const Homework = model<IHomework>('Homework', homeworkSchema);

// ---------- Teacher leave ----------
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ILeaveRequest {
  schoolId: Types.ObjectId;
  teacherId: Types.ObjectId;
  type: string;
  from: string;
  to: string;
  reason: string;
  document?: IAttachment;
  status: LeaveStatus;
  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
  decisionComment?: string;
  createdAt?: Date;
}

const leaveSchema = new Schema<ILeaveRequest>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    reason: { type: String, required: true },
    document: attachmentSchema,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionComment: String,
  },
  { timestamps: true },
);
leaveSchema.index({ schoolId: 1, status: 1, from: 1 });
leaveSchema.index({ schoolId: 1, teacherId: 1, from: 1 });

export const LeaveRequest = model<ILeaveRequest>('LeaveRequest', leaveSchema);

// ---------- Announcements and events ----------
export type AudienceKind = 'all' | 'teachers' | 'parents' | 'classes';

export interface IAnnouncement {
  schoolId: Types.ObjectId;
  kind: 'notice' | 'event';
  title: string;
  body: string;
  audience: { kind: AudienceKind; classIds: Types.ObjectId[] };
  event?: { date: string; time?: string; place?: string };
  publishAt: Date;
  status: 'scheduled' | 'published';
  createdBy: Types.ObjectId;
  createdAt?: Date;
}

const announcementSchema = new Schema<IAnnouncement>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    kind: { type: String, enum: ['notice', 'event'], required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    audience: {
      kind: { type: String, enum: ['all', 'teachers', 'parents', 'classes'], default: 'all' },
      classIds: [{ type: Schema.Types.ObjectId, ref: 'ClassSection' }],
    },
    event: { date: String, time: String, place: String },
    publishAt: { type: Date, required: true },
    status: { type: String, enum: ['scheduled', 'published'], required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
announcementSchema.index({ schoolId: 1, status: 1, publishAt: -1 });

export const Announcement = model<IAnnouncement>('Announcement', announcementSchema);
