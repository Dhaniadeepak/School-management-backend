import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { enqueue } from '../jobs/queue';
import { Counter, FeeDue, Payment, Student } from '../models';
import { financialYear, todayISO } from '../utils/dates';
import { AppError } from '../utils/errors';
import { notifyUsers } from './notifications';

const razorpay =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
    : null;

export const paymentsEnabled = () => !!razorpay || env.PAYMENTS_MOCK;

/** Creates an order at the gateway. The app never decides a payment succeeded. */
export async function createGatewayOrder(
  amountRupees: number,
  receipt: string,
  notes: Record<string, string>,
): Promise<{ orderId: string; gateway: 'razorpay' | 'mock'; keyId?: string }> {
  if (razorpay) {
    const order = await razorpay.orders.create({
      amount: Math.round(amountRupees * 100),
      currency: 'INR',
      receipt: receipt.slice(0, 40),
      notes,
    });
    return { orderId: order.id, gateway: 'razorpay', keyId: env.RAZORPAY_KEY_ID };
  }
  if (env.PAYMENTS_MOCK) return { orderId: `mock_order_${crypto.randomUUID()}`, gateway: 'mock' };
  throw new AppError(503, 'Online payment is not set up for this school yet', 'PAYMENTS_DISABLED');
}

export function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function nextReceiptNo(schoolId: Types.ObjectId, paidAtISO: string): Promise<string> {
  const fy = financialYear(paidAtISO);
  const counter = await Counter.findOneAndUpdate(
    { key: `receipt:${schoolId.toString()}:${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return `RCPT/${fy}/${String(counter?.seq ?? 1).padStart(6, '0')}`;
}

/**
 * Marks a payment as paid. Safe to call twice for the same order: only the first call
 * changes anything, so a repeated webhook never double-counts.
 */
export async function confirmPaymentPaid(orderId: string, gatewayPaymentId: string, method?: string) {
  const paidAt = new Date();
  const payment = await Payment.findOneAndUpdate(
    { gatewayOrderId: orderId, status: { $in: ['created', 'failed'] } },
    { $set: { status: 'paid', gatewayPaymentId, method, paidAt }, $unset: { failureReason: 1 } },
    { new: true },
  );
  if (!payment) return null; // unknown order or already paid

  payment.receiptNo = await nextReceiptNo(payment.schoolId, todayISO());
  await payment.save();
  await FeeDue.updateMany(
    { _id: { $in: payment.dueIds }, schoolId: payment.schoolId },
    { $set: { status: 'paid', paymentId: payment._id, paidAt } },
  );
  await enqueue('receipt-pdf', { paymentId: payment._id.toString() });

  const student = await Student.findById(payment.studentId).select('name').lean();
  await notifyUsers({
    schoolId: payment.schoolId,
    userIds: [payment.parentId],
    type: 'fee_paid',
    title: 'Fee payment received',
    body: `Rs. ${payment.amount.toLocaleString('en-IN')} received for ${student?.name ?? 'your child'}. Receipt ${payment.receiptNo}.`,
    data: { paymentId: payment._id.toString() },
    dedupeKey: () => `fee_paid:${payment._id.toString()}`,
  });
  return payment;
}

export async function markPaymentFailed(orderId: string, reason?: string) {
  await Payment.updateOne(
    { gatewayOrderId: orderId, status: 'created' },
    { $set: { status: 'failed', failureReason: reason?.slice(0, 300) } },
  );
}

export async function markPaymentRefunded(gatewayPaymentId: string) {
  const payment = await Payment.findOneAndUpdate(
    { gatewayPaymentId, status: 'paid' },
    { $set: { status: 'refunded' } },
    { new: true },
  );
  if (payment) {
    await FeeDue.updateMany(
      { _id: { $in: payment.dueIds }, paymentId: payment._id },
      { $set: { status: 'pending' }, $unset: { paymentId: 1, paidAt: 1 } },
    );
  }
}
