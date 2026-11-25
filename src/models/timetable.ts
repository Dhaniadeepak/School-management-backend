import { Schema, Types, model } from 'mongoose';

/**
 * A slot in a teacher's weekly timetable.
 * kind "class": teaching a class. kind "duty": a free period with a duty (e.g. cover 6-B, Room 12).
 * A period with no entry is a plain free period.
 * Admins edit "draft" entries; publishing copies them into a new "published" version.
 */
export interface ITimetableEntry {
  schoolId: Types.ObjectId;
  status: 'draft' | 'published' | 'archived';
  version: number;
  teacherId: Types.ObjectId;
  day: number; // 1 = Monday ... 7 = Sunday
  period: number;
  kind: 'class' | 'duty';
  classId?: Types.ObjectId;
  subject?: string;
  room?: string;
  note?: string;
}

const entrySchema = new Schema<ITimetableEntry>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    status: { type: String, enum: ['draft', 'published', 'archived'], required: true },
    version: { type: Number, default: 0 },
    teacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: Number, required: true, min: 1, max: 7 },
    period: { type: Number, required: true },
    kind: { type: String, enum: ['class', 'duty'], required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection' },
    subject: String,
    room: String,
    note: String,
  },
  { timestamps: true },
);
entrySchema.index({ schoolId: 1, status: 1, teacherId: 1, day: 1, period: 1 });
entrySchema.index({ schoolId: 1, status: 1, classId: 1, day: 1, period: 1 });

export const TimetableEntry = model<ITimetableEntry>('TimetableEntry', entrySchema);

/** A one-day override: substituteTeacher takes classId in this period on this date. */
export interface ISubstitution {
  schoolId: Types.ObjectId;
  date: string;
  period: number;
  classId: Types.ObjectId;
  substituteTeacherId: Types.ObjectId;
  originalTeacherId?: Types.ObjectId;
  subject?: string;
  room?: string;
  note?: string;
  createdBy: Types.ObjectId;
}

const substitutionSchema = new Schema<ISubstitution>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    date: { type: String, required: true },
    period: { type: Number, required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    substituteTeacherId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalTeacherId: { type: Schema.Types.ObjectId, ref: 'User' },
    subject: String,
    room: String,
    note: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
substitutionSchema.index({ schoolId: 1, date: 1, period: 1, substituteTeacherId: 1 }, { unique: true });
substitutionSchema.index({ schoolId: 1, date: 1, period: 1, classId: 1 }, { unique: true });

export const Substitution = model<ISubstitution>('Substitution', substitutionSchema);
