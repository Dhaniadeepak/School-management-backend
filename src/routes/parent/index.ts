import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { authenticate, ctx, requireRole } from '../../middleware/auth';
import { Announcement, Attendance, ClassSection, FeeDue, Homework, ParentStudent, Payment, School, Student, classLabel } from '../../models';
import { loadParentChild, parentStudentIds } from '../../services/access';
import { confirmPaymentPaid, createGatewayOrder, paymentsEnabled } from '../../services/payments';
import { generateReceipt } from '../../services/receipts';
import { signedUrl, withUrls } from '../../services/storage';
import { daysInMonth, todayISO, weekdayOf } from '../../utils/dates';
import { badRequest, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zId } from '../../utils/http';

/** Parent app API. Every child lookup goes through the parent-student link. */
const router = Router();
router.use(authenticate, requireRole('parent'));

// ---------- P2: children ----------
router.get(
  '/children',
  ah(async (req, res) => {
    const who = ctx(req);
    const links = await ParentStudent.find({ schoolId: who.schoolId, parentId: who.userId }).lean();
    const students = await Student.find({ schoolId: who.schoolId, _id: { $in: links.map((l) => l.studentId) }, active: true }).lean();
    const classes = await ClassSection.find({ schoolId: who.schoolId, _id: { $in: students.map((s) => s.classId) } }).lean();
    ok(
      res,
      students
        .map((s) => ({
          id: s._id.toString(),
          name: s.name,
          admissionNo: s.admissionNo,
          rollNo: s.rollNo ?? null,
          classId: s.classId.toString(),
          className: classLabel(classes.find((c) => c._id.equals(s.classId))),
          relation: links.find((l) => l.studentId.equals(s._id))?.relation ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }),
);

// ---------- P4: monthly attendance calendar ----------
router.get(
  '/children/:studentId/attendance',
  ah(async (req, res) => {
    const who = ctx(req);
    const student = await loadParentChild(who.schoolId, who.userId, oid(req.params.studentId, 'child'));
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(() => todayISO().slice(0, 7)) }), req.query);
    const days = daysInMonth(month);
    const [records, school] = await Promise.all([
      Attendance.find({ schoolId: who.schoolId, studentId: student._id, date: { $gte: days[0], $lte: days[days.length - 1] } }).lean(),
      School.findById(who.schoolId).select('holidays settings.workingDays').lean(),
    ]);
    const byDate = new Map(records.map((r) => [r.date, r.status]));
    const today = todayISO();

    const calendar = days.map((date) => {
      const holiday = school?.holidays.find((h) => h.date === date);
      const status = byDate.get(date);
      if (status) return { date, status };
      if (holiday) return { date, status: 'holiday', label: holiday.name };
      if (!school?.settings.workingDays.includes(weekdayOf(date))) return { date, status: 'off' };
      return { date, status: date > today ? 'upcoming' : 'not_marked' };
    });
    const present = records.filter((r) => r.status === 'present').length;
    const absent = records.filter((r) => r.status === 'absent').length;
    ok(res, {
      month,
      days: calendar,
      summary: { present, absent, percentage: present + absent ? Math.round((present / (present + absent)) * 1000) / 10 : null },
    });
  }),
);

// ---------- P5: homework ----------
router.get(
  '/children/:studentId/homework',
  ah(async (req, res) => {
    const who = ctx(req);
    const student = await loadParentChild(who.schoolId, who.userId, oid(req.params.studentId, 'child'));
    const items = await Homework.find({ schoolId: who.schoolId, classId: student.classId }).sort({ createdAt: -1 }).limit(100).lean();
    ok(
      res,
      items.map((h) => ({
        id: h._id.toString(),
        subject: h.subject,
        title: h.title,
        description: h.description ?? '',
        dueDate: h.dueDate,
        attachments: withUrls(h.attachments),
        postedAt: h.createdAt,
        updatedAt: h.updatedAt,
      })),
    );
  }),
);

// ---------- P6: announcements and events ----------
router.get(
  '/announcements',
  ah(async (req, res) => {
    const who = ctx(req);
    const studentIds = await parentStudentIds(who.schoolId, who.userId);
    const classIds = (await Student.distinct('classId', { schoolId: who.schoolId, _id: { $in: studentIds } })) as Types.ObjectId[];
    const items = await Announcement.find({
      schoolId: who.schoolId,
      status: 'published',
      $or: [{ 'audience.kind': { $in: ['all', 'parents'] } }, { 'audience.kind': 'classes', 'audience.classIds': { $in: classIds } }],
    })
      .sort({ publishAt: -1 })
      .limit(100)
      .lean();
    ok(
      res,
      items.map((a) => ({ id: a._id.toString(), kind: a.kind, title: a.title, body: a.body, event: a.event?.date ? a.event : null, publishAt: a.publishAt })),
    );
  }),
);

// ---------- P7 / P8: fees, payments, receipts ----------
router.get(
  '/children/:studentId/fees',
  ah(async (req, res) => {
    const who = ctx(req);
    const student = await loadParentChild(who.schoolId, who.userId, oid(req.params.studentId, 'child'));
    const [dues, payments] = await Promise.all([
      FeeDue.find({ schoolId: who.schoolId, studentId: student._id }).sort({ academicYear: -1, installmentNo: 1 }).lean(),
      Payment.find({ schoolId: who.schoolId, studentId: student._id, status: { $in: ['paid', 'refunded'] } }).sort({ paidAt: -1 }).lean(),
    ]);
    ok(res, {
      paymentsEnabled: paymentsEnabled(),
      dues: dues.map((d) => ({
        id: d._id.toString(),
        academicYear: d.academicYear,
        label: d.label,
        installmentNo: d.installmentNo,
        amount: d.amount,
        dueDate: d.dueDate,
        status: d.status,
        overdue: d.status === 'pending' && d.dueDate < todayISO(),
        paidAt: d.paidAt ?? null,
      })),
      payments: payments.map((p) => ({
        id: p._id.toString(),
        amount: p.amount,
        status: p.status,
        receiptNo: p.receiptNo ?? null,
        paidAt: p.paidAt ?? null,
        method: p.method ?? null,
        transactionId: p.gatewayPaymentId ?? null,
      })),
    });
  }),
);

/** Creates a gateway order for the chosen dues. The amount always comes from the server. */
router.post(
  '/children/:studentId/fees/orders',
  ah(async (req, res) => {
    const who = ctx(req);
    const student = await loadParentChild(who.schoolId, who.userId, oid(req.params.studentId, 'child'));
    const { dueIds } = parse(z.object({ dueIds: z.array(zId).min(1).max(10) }), req.body);
    const dues = await FeeDue.find({ _id: { $in: dueIds }, schoolId: who.schoolId, studentId: student._id, status: 'pending' }).lean();
    if (dues.length !== dueIds.length) throw badRequest('Some of these fees are already paid or not found. Refresh and try again.');

    // Installment 2 cannot be paid before installment 1 of the same fee.
    for (const d of dues) {
      if (d.installmentNo === 2) {
        const first = await FeeDue.findOne({ feeStructureId: d.feeStructureId, studentId: student._id, installmentNo: 1 }).lean();
        if (first?.status === 'pending' && !dues.some((x) => x._id.equals(first._id))) {
          throw badRequest('Please pay the first installment first (or both together)');
        }
      }
    }

    const amount = Math.round(dues.reduce((s, d) => s + d.amount, 0) * 100) / 100;
    const payment = new Payment({
      schoolId: who.schoolId,
      studentId: student._id,
      parentId: who.userId,
      dueIds: dues.map((d) => d._id),
      amount,
      gateway: 'mock',
      gatewayOrderId: 'pending',
    });
    const order = await createGatewayOrder(amount, payment._id.toString(), {
      paymentId: payment._id.toString(),
      schoolId: who.schoolId.toString(),
      studentId: student._id.toString(),
    });
    payment.gateway = order.gateway;
    payment.gatewayOrderId = order.orderId;
    await payment.save();

    const school = await School.findById(who.schoolId).select('name').lean();
    ok(
      res,
      {
        paymentId: payment._id.toString(),
        gateway: order.gateway,
        orderId: order.orderId,
        keyId: order.keyId ?? null,
        amount,
        amountPaise: Math.round(amount * 100),
        currency: 'INR',
        schoolName: school?.name ?? '',
        studentName: student.name,
      },
      201,
    );
  }),
);

async function loadOwnPayment(req: Parameters<typeof ctx>[0]) {
  const who = ctx(req);
  const payment = await Payment.findOne({ _id: oid(req.params.paymentId), schoolId: who.schoolId, parentId: who.userId });
  if (!payment) throw notFound('Payment not found');
  return payment;
}

/** The app polls this after checkout; the status only changes when the webhook arrives. */
router.get(
  '/payments/:paymentId',
  ah(async (req, res) => {
    const p = await loadOwnPayment(req);
    ok(res, { id: p._id.toString(), status: p.status, receiptNo: p.receiptNo ?? null, amount: p.amount, paidAt: p.paidAt ?? null });
  }),
);

router.get(
  '/payments/:paymentId/receipt',
  ah(async (req, res) => {
    const p = await loadOwnPayment(req);
    if (p.status !== 'paid' && p.status !== 'refunded') throw badRequest('The receipt is available once the payment is confirmed');
    const key = p.receiptKey ?? (await generateReceipt(p._id));
    ok(res, { url: signedUrl(key, 600, `${(p.receiptNo ?? 'receipt').replace(/\//g, '-')}.pdf`) });
  }),
);

/** Development only: completes a mock payment the same way the gateway webhook would. */
router.post(
  '/payments/:paymentId/mock-complete',
  ah(async (req, res) => {
    if (!env.PAYMENTS_MOCK) throw notFound();
    const p = await loadOwnPayment(req);
    if (p.gateway !== 'mock') throw badRequest('Not a mock payment');
    await confirmPaymentPaid(p.gatewayOrderId, `mock_pay_${p._id.toString()}`, 'upi');
    ok(res, { ok: true });
  }),
);

export default router;
