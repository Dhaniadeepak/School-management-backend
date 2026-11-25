import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { ClassSection, FeeDue, FeeStructure, Payment, School, Student, classLabel } from '../../models';
import { audit } from '../../services/audit';
import { buildXlsx } from '../../services/excel';
import { todayISO } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate, zId } from '../../utils/http';

/** A8: fee structure per class, dues per student, paid/pending lists, export. */
const router = Router();

const money = z.coerce.number().min(0).max(10_000_000);
const round2 = (n: number) => Math.round(n * 100) / 100;

const structureBody = z.object({
  classId: zId,
  academicYear: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  heads: z.array(z.object({ name: z.string().trim().min(1).max(40), amount: money })).min(1).max(20),
  dueDate: zDate,
  allowInstallments: z.boolean().default(false),
  installments: z
    .array(z.object({ label: z.string().trim().min(1).max(40), dueDate: zDate, amount: money }))
    .length(2)
    .optional(),
});

async function validateStructure(schoolId: Types.ObjectId, b: z.infer<typeof structureBody>) {
  const school = await School.findById(schoolId).lean();
  if (!school) throw notFound('School not found');
  if (!(await ClassSection.exists({ _id: b.classId, schoolId }))) throw badRequest('Class not found');
  const total = round2(b.heads.reduce((s, h) => s + h.amount, 0));
  if (total <= 0) throw badRequest('Total fee must be more than zero');

  const allow = b.allowInstallments && school.settings.allowInstallments;
  if (b.allowInstallments && !school.settings.allowInstallments) {
    throw badRequest('Installments are switched off for this school (Settings)');
  }
  if (allow) {
    if (!b.installments) throw badRequest('Give the two installments');
    const sum = round2(b.installments.reduce((s, i) => s + i.amount, 0));
    if (sum !== total) throw badRequest(`Installments add up to ${sum}, but the total fee is ${total}`);
  }
  return { total, allow, academicYear: b.academicYear ?? school.settings.academicYear };
}

router.get(
  '/structures',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { academicYear } = parse(z.object({ academicYear: z.string().optional() }), req.query);
    const items = await FeeStructure.find({ schoolId, ...(academicYear ? { academicYear } : {}) }).lean();
    const classes = await ClassSection.find({ schoolId }).lean();
    const dueCounts = await FeeDue.aggregate<{ _id: { s: Types.ObjectId; st: string }; n: number; amount: number }>([
      { $match: { schoolId, feeStructureId: { $in: items.map((i) => i._id) } } },
      { $group: { _id: { s: '$feeStructureId', st: '$status' }, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    const count = (id: Types.ObjectId, st: string) => dueCounts.find((d) => d._id.s.equals(id) && d._id.st === st);
    ok(
      res,
      items.map((s) => ({
        id: s._id.toString(),
        classId: s.classId.toString(),
        className: classLabel(classes.find((c) => c._id.equals(s.classId))),
        academicYear: s.academicYear,
        heads: s.heads,
        total: s.total,
        dueDate: s.dueDate,
        allowInstallments: s.allowInstallments,
        installments: s.installments,
        dues: {
          pending: count(s._id, 'pending')?.n ?? 0,
          paid: count(s._id, 'paid')?.n ?? 0,
          pendingAmount: count(s._id, 'pending')?.amount ?? 0,
          paidAmount: count(s._id, 'paid')?.amount ?? 0,
        },
      })),
    );
  }),
);

router.post(
  '/structures',
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(structureBody, req.body);
    const { total, allow, academicYear } = await validateStructure(who.schoolId, b);
    if (await FeeStructure.exists({ schoolId: who.schoolId, classId: b.classId, academicYear })) {
      throw conflict('This class already has a fee structure for that year. Edit it instead.');
    }
    const s = await FeeStructure.create({
      schoolId: who.schoolId,
      classId: new Types.ObjectId(b.classId),
      academicYear,
      heads: b.heads,
      total,
      dueDate: b.dueDate,
      allowInstallments: allow,
      installments: allow ? b.installments : [],
      createdBy: who.userId,
    });
    await audit(who, 'fees.structure.create', 'fee_structure', s._id.toString(), undefined, s.toObject());
    ok(res, { id: s._id.toString() }, 201);
  }),
);

/** Editing is allowed until someone has paid; pending dues are then regenerated. */
router.put(
  '/structures/:id',
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(structureBody, req.body);
    const s = await FeeStructure.findOne({ _id: oid(req.params.id), schoolId: who.schoolId });
    if (!s) throw notFound('Fee structure not found');
    if (b.classId !== s.classId.toString()) throw badRequest('The class of a fee structure cannot be changed');
    if (await FeeDue.exists({ feeStructureId: s._id, status: 'paid' })) {
      throw conflict('Some parents have already paid against this fee, so it can no longer be changed');
    }
    const { total, allow } = await validateStructure(who.schoolId, { ...b, academicYear: s.academicYear });
    const before = s.toObject();
    s.heads = b.heads;
    s.total = total;
    s.dueDate = b.dueDate;
    s.allowInstallments = allow;
    s.installments = allow && b.installments ? b.installments : [];
    await s.save();
    const removed = await FeeDue.deleteMany({ feeStructureId: s._id, status: 'pending' });
    await audit(who, 'fees.structure.update', 'fee_structure', s._id.toString(), before, s.toObject());
    ok(res, { id: s._id.toString(), duesRemoved: removed.deletedCount });
  }),
);

/** Creates the dues for every active student of the class (skips ones that exist). */
router.post(
  '/structures/:id/generate-dues',
  ah(async (req, res) => {
    const who = ctx(req);
    const s = await FeeStructure.findOne({ _id: oid(req.params.id), schoolId: who.schoolId }).lean();
    if (!s) throw notFound('Fee structure not found');
    const students = await Student.find({ schoolId: who.schoolId, classId: s.classId, active: true }).select('_id').lean();

    const plan = s.allowInstallments
      ? s.installments.map((i, idx) => ({ installmentNo: idx + 1, label: i.label, amount: i.amount, dueDate: i.dueDate }))
      : [{ installmentNo: 0, label: 'Annual fee', amount: s.total, dueDate: s.dueDate }];

    const ops = students.flatMap((st) =>
      plan.map((p) => ({
        updateOne: {
          filter: { feeStructureId: s._id, studentId: st._id, installmentNo: p.installmentNo },
          update: {
            $setOnInsert: {
              schoolId: who.schoolId,
              classId: s.classId,
              academicYear: s.academicYear,
              label: p.label,
              amount: p.amount,
              dueDate: p.dueDate,
              status: 'pending',
            },
          },
          upsert: true,
        },
      })),
    );
    const result = ops.length ? await FeeDue.bulkWrite(ops, { ordered: false }) : null;
    ok(res, { students: students.length, created: result?.upsertedCount ?? 0 });
  }),
);

const duesQuery = z.object({
  classId: zId.optional(),
  status: z.enum(['pending', 'paid']).optional(),
  academicYear: z.string().optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

async function loadDues(schoolId: Types.ObjectId, q: z.infer<typeof duesQuery>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: Record<string, any> = { schoolId };
  if (q.classId) filter.classId = new Types.ObjectId(q.classId);
  if (q.status) filter.status = q.status;
  if (q.academicYear) filter.academicYear = q.academicYear;
  if (q.overdue === 'true') {
    filter.status = 'pending';
    filter.dueDate = { $lt: todayISO() };
  }
  const dues = await FeeDue.find(filter).sort({ classId: 1, dueDate: 1 }).limit(10000).lean();
  const [students, classes, payments] = await Promise.all([
    Student.find({ _id: { $in: dues.map((d) => d.studentId) } }).select('name admissionNo rollNo').lean(),
    ClassSection.find({ schoolId }).lean(),
    Payment.find({ _id: { $in: dues.map((d) => d.paymentId).filter(Boolean) } }).select('receiptNo gatewayPaymentId').lean(),
  ]);
  return dues.map((d) => {
    const st = students.find((s) => s._id.equals(d.studentId));
    const pay = d.paymentId ? payments.find((p) => p._id.equals(d.paymentId)) : undefined;
    return {
      id: d._id.toString(),
      studentId: d.studentId.toString(),
      studentName: st?.name ?? '',
      admissionNo: st?.admissionNo ?? '',
      rollNo: st?.rollNo ?? null,
      className: classLabel(classes.find((c) => c._id.equals(d.classId))),
      academicYear: d.academicYear,
      label: d.label,
      amount: d.amount,
      dueDate: d.dueDate,
      status: d.status,
      paidAt: d.paidAt ?? null,
      receiptNo: pay?.receiptNo ?? null,
      transactionId: pay?.gatewayPaymentId ?? null,
    };
  });
}

router.get(
  '/dues',
  ah(async (req, res) => {
    const rows = await loadDues(ctx(req).schoolId, parse(duesQuery, req.query));
    const sum = (st: string) => round2(rows.filter((r) => r.status === st).reduce((s, r) => s + r.amount, 0));
    ok(res, { items: rows, totals: { paid: sum('paid'), pending: sum('pending'), count: rows.length } });
  }),
);

router.get(
  '/dues/export',
  ah(async (req, res) => {
    const rows = await loadDues(ctx(req).schoolId, parse(duesQuery, req.query));
    const buf = await buildXlsx(
      'Fees',
      [
        { header: 'Class', key: 'className', width: 8 },
        { header: 'Roll', key: 'rollNo', width: 6 },
        { header: 'Admission No', key: 'admissionNo', width: 14 },
        { header: 'Student', key: 'studentName', width: 24 },
        { header: 'Year', key: 'academicYear', width: 9 },
        { header: 'Fee', key: 'label', width: 16 },
        { header: 'Amount (Rs.)', key: 'amount', width: 12 },
        { header: 'Due date', key: 'dueDate', width: 12 },
        { header: 'Status', key: 'status', width: 9 },
        { header: 'Paid on', key: 'paidOn', width: 12 },
        { header: 'Receipt No', key: 'receiptNo', width: 22 },
        { header: 'Transaction ID', key: 'transactionId', width: 24 },
      ],
      rows.map((r) => ({ ...r, paidOn: r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 10) : '' })),
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="fees.xlsx"');
    res.send(buf);
  }),
);

/** All payment attempts, for reconciling with the gateway's settlement report. */
router.get(
  '/payments',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const q = parse(z.object({ status: z.enum(['created', 'paid', 'failed', 'refunded']).optional() }), req.query);
    const items = await Payment.find({ schoolId, ...(q.status ? { status: q.status } : {}) }).sort({ createdAt: -1 }).limit(500).lean();
    const students = await Student.find({ _id: { $in: items.map((p) => p.studentId) } }).select('name admissionNo').lean();
    ok(
      res,
      items.map((p) => {
        const st = students.find((s) => s._id.equals(p.studentId));
        return {
          id: p._id.toString(),
          studentName: st?.name ?? '',
          admissionNo: st?.admissionNo ?? '',
          amount: p.amount,
          status: p.status,
          gateway: p.gateway,
          orderId: p.gatewayOrderId,
          transactionId: p.gatewayPaymentId ?? null,
          method: p.method ?? null,
          receiptNo: p.receiptNo ?? null,
          createdAt: p.createdAt,
          paidAt: p.paidAt ?? null,
          failureReason: p.failureReason ?? null,
        };
      }),
    );
  }),
);

export default router;
