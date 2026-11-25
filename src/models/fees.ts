import { Schema, Types, model } from 'mongoose';

/** Fee for one class for one academic year. Amounts are in rupees. */
export interface IFeeStructure {
  schoolId: Types.ObjectId;
  classId: Types.ObjectId;
  academicYear: string;
  heads: { name: string; amount: number }[];
  total: number;
  dueDate: string; // due date when paid in one go
  allowInstallments: boolean;
  installments: { label: string; dueDate: string; amount: number }[];
  createdBy: Types.ObjectId;
}

const feeStructureSchema = new Schema<IFeeStructure>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    academicYear: { type: String, required: true },
    heads: [{ _id: false, name: String, amount: Number }],
    total: { type: Number, required: true },
    dueDate: { type: String, required: true },
    allowInstallments: { type: Boolean, default: false },
    installments: [{ _id: false, label: String, dueDate: String, amount: Number }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
feeStructureSchema.index({ schoolId: 1, classId: 1, academicYear: 1 }, { unique: true });

export const FeeStructure = model<IFeeStructure>('FeeStructure', feeStructureSchema);

/**
 * What one student owes. With installments there is one due per installment (1, 2);
 * otherwise a single due (installmentNo 0). Paying both installments together = paying in full.
 */
export interface IFeeDue {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  classId: Types.ObjectId;
  feeStructureId: Types.ObjectId;
  academicYear: string;
  installmentNo: number;
  label: string;
  amount: number;
  dueDate: string;
  status: 'pending' | 'paid';
  paymentId?: Types.ObjectId;
  paidAt?: Date;
}

const feeDueSchema = new Schema<IFeeDue>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    classId: { type: Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    feeStructureId: { type: Schema.Types.ObjectId, ref: 'FeeStructure', required: true },
    academicYear: { type: String, required: true },
    installmentNo: { type: Number, required: true },
    label: { type: String, required: true },
    amount: { type: Number, required: true },
    dueDate: { type: String, required: true },
    status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    paidAt: Date,
  },
  { timestamps: true },
);
feeDueSchema.index({ feeStructureId: 1, studentId: 1, installmentNo: 1 }, { unique: true });
feeDueSchema.index({ schoolId: 1, classId: 1, status: 1 });
feeDueSchema.index({ schoolId: 1, studentId: 1 });

export const FeeDue = model<IFeeDue>('FeeDue', feeDueSchema);

export type PaymentStatus = 'created' | 'paid' | 'failed' | 'refunded';

/** Every payment attempt is kept, whatever happens to it. */
export interface IPayment {
  schoolId: Types.ObjectId;
  studentId: Types.ObjectId;
  parentId: Types.ObjectId;
  dueIds: Types.ObjectId[];
  amount: number;
  currency: string;
  gateway: 'razorpay' | 'mock';
  gatewayOrderId: string;
  gatewayPaymentId?: string;
  method?: string;
  status: PaymentStatus;
  failureReason?: string;
  receiptNo?: string;
  receiptKey?: string;
  paidAt?: Date;
  createdAt?: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    schoolId: { type: Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dueIds: [{ type: Schema.Types.ObjectId, ref: 'FeeDue' }],
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    gateway: { type: String, enum: ['razorpay', 'mock'], required: true },
    gatewayOrderId: { type: String, required: true, unique: true },
    gatewayPaymentId: String,
    method: String,
    status: { type: String, enum: ['created', 'paid', 'failed', 'refunded'], default: 'created' },
    failureReason: String,
    receiptNo: String,
    receiptKey: String,
    paidAt: Date,
  },
  { timestamps: true },
);
paymentSchema.index({ schoolId: 1, status: 1, paidAt: -1 });
paymentSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });

export const Payment = model<IPayment>('Payment', paymentSchema);

/** Stored webhook events; the unique eventId makes processing idempotent. */
export interface IWebhookEvent {
  provider: string;
  eventId: string;
  type: string;
  payload: unknown;
  processedAt?: Date;
  error?: string;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    type: String,
    payload: Schema.Types.Mixed,
    processedAt: Date,
    error: String,
  },
  { timestamps: true },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const WebhookEvent = model<IWebhookEvent>('WebhookEvent', webhookEventSchema);

/** Sequence counters, e.g. receipt numbers per school per financial year. */
const counterSchema = new Schema<{ key: string; seq: number }>({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});
export const Counter = model('Counter', counterSchema);
