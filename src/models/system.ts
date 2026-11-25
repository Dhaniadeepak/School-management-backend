import { Schema, Types, model } from 'mongoose';

// ---------- In-app notifications (also the push delivery log) ----------
export interface INotification {
  schoolId: Types.ObjectId;
  userId: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  channel: 'push';
  deliveryStatus: 'queued' | 'sent' | 'failed' | 'skipped';
  read: boolean;
  readAt?: Date;
  dedupeKey?: string;
  createdAt?: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    data: { type: Schema.Types.Mixed },
    channel: { type: String, default: 'push' },
    deliveryStatus: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], default: 'queued' },
    read: { type: Boolean, default: false },
    readAt: Date,
    dedupeKey: String,
  },
  { timestamps: true },
);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

export const Notification = model<INotification>('Notification', notificationSchema);

// ---------- Background jobs (simple MongoDB-backed queue) ----------
export type JobType = 'absence-alerts' | 'push' | 'announcement-publish' | 'receipt-pdf' | 'class-parents-notify';

export interface IJob {
  type: JobType;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt?: Date;
  doneAt?: Date;
  lastError?: string;
}

const jobSchema = new Schema<IJob>(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAt: { type: Date, default: () => new Date() },
    lockedAt: Date,
    doneAt: Date,
    lastError: String,
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1 });
// Finished jobs are removed after 14 days
jobSchema.index({ doneAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });

export const Job = model<IJob>('Job', jobSchema);

// ---------- Audit log ----------
export interface IAuditLog {
  schoolId: Types.ObjectId;
  userId: Types.ObjectId;
  action: string;
  entity: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  createdAt?: Date;
}

const auditSchema = new Schema<IAuditLog>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: String,
    oldValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ schoolId: 1, createdAt: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditSchema);

// ---------- One-time passwords ----------
export interface IOtp {
  phone: string;
  purpose: 'parent_login' | 'password_reset';
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt?: Date;
  createdAt?: Date;
}

const otpSchema = new Schema<IOtp>(
  {
    phone: { type: String, required: true },
    purpose: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
otpSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
// Keep codes for an hour so the "3 codes per 15 minutes" limit can be counted, then delete
otpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

export const Otp = model<IOtp>('Otp', otpSchema);
