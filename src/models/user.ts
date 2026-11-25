import { Schema, Types, model } from 'mongoose';

export type Role = 'admin' | 'teacher' | 'parent';
export type UserStatus = 'pending' | 'approved' | 'rejected' | 'deactivated';

export interface IUser {
  schoolId: Types.ObjectId;
  role: Role;
  name: string;
  phone?: string;
  email?: string;
  passwordHash?: string;
  status: UserStatus;
  failedLoginCount: number;
  lockUntil?: Date;
  tokenVersion: number;
  fcmTokens: string[];
  language: string;
  lastLoginAt?: Date;
  createdAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    role: { type: String, enum: ['admin', 'teacher', 'parent'], required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'deactivated'],
      default: 'approved',
    },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: Date,
    tokenVersion: { type: Number, default: 0 },
    fcmTokens: { type: [String], default: [] },
    language: { type: String, default: 'en' },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ schoolId: 1, role: 1, status: 1 });
// One account per phone per role per school. Teachers are additionally blocked from
// registering a phone that any teacher already uses (checked in the register route).
userSchema.index(
  { schoolId: 1, role: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
userSchema.index({ role: 1, phone: 1 });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

export const User = model<IUser>('User', userSchema);

export interface ITeacherProfile {
  schoolId: Types.ObjectId;
  userId: Types.ObjectId;
  subjects: string[];
  qualification?: string;
  rejectionReason?: string;
  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
}

const teacherProfileSchema = new Schema<ITeacherProfile>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    subjects: { type: [String], default: [] },
    qualification: String,
    rejectionReason: String,
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true },
);

export const TeacherProfile = model<ITeacherProfile>('TeacherProfile', teacherProfileSchema);
