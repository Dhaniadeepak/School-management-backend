import { Schema, Types, model } from 'mongoose';

/** One class-section, e.g. class "6" section "B" (shown as 6-B). */
export interface IClassSection {
  schoolId: Types.ObjectId;
  name: string;
  section: string;
  classTeacherId?: Types.ObjectId;
}

const classSchema = new Schema<IClassSection>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    name: { type: String, required: true, trim: true },
    section: { type: String, required: true, trim: true, uppercase: true },
    classTeacherId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
classSchema.index({ schoolId: 1, name: 1, section: 1 }, { unique: true });

export const ClassSection = model<IClassSection>('ClassSection', classSchema);

export const classLabel = (c: { name: string; section: string } | null | undefined) =>
  c ? `${c.name}-${c.section}` : '';

export interface IStudent {
  schoolId: Types.ObjectId;
  admissionNo: string;
  name: string;
  classId: Types.ObjectId;
  rollNo?: number;
  gender?: string;
  dob?: string;
  active: boolean;
}

const studentSchema = new Schema<IStudent>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    admissionNo: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    rollNo: Number,
    gender: String,
    dob: String,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
studentSchema.index({ schoolId: 1, admissionNo: 1 }, { unique: true });
studentSchema.index({ schoolId: 1, classId: 1, rollNo: 1 });

export const Student = model<IStudent>('Student', studentSchema);

export interface IParentStudent {
  schoolId: Types.ObjectId;
  parentId: Types.ObjectId;
  studentId: Types.ObjectId;
  relation: string;
}

const parentStudentSchema = new Schema<IParentStudent>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    relation: { type: String, default: 'Guardian' },
  },
  { timestamps: true },
);
parentStudentSchema.index({ parentId: 1, studentId: 1 }, { unique: true });
parentStudentSchema.index({ schoolId: 1, studentId: 1 });

export const ParentStudent = model<IParentStudent>('ParentStudent', parentStudentSchema);
