import { Router } from 'express';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { attachmentUpload } from '../../middleware/upload';
import { LeaveRequest, School } from '../../models';
import { adminIds, notifyUsers } from '../../services/notifications';
import { saveFile, withUrls } from '../../services/storage';
import { eachDate, todayISO } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate } from '../../utils/http';

/** T6: apply for leave, see the decision, cancel a pending request. */
const router = Router();

router.get(
  '/types',
  ah(async (req, res) => {
    const school = await School.findById(ctx(req).schoolId).select('settings.leaveTypes').lean();
    ok(res, school?.settings.leaveTypes ?? []);
  }),
);

router.get(
  '/',
  ah(async (req, res) => {
    const who = ctx(req);
    const items = await LeaveRequest.find({ schoolId: who.schoolId, teacherId: who.userId }).sort({ from: -1 }).limit(100).lean();
    ok(
      res,
      items.map((l) => ({
        id: l._id.toString(),
        type: l.type,
        from: l.from,
        to: l.to,
        days: eachDate(l.from, l.to).length,
        reason: l.reason,
        status: l.status,
        decisionComment: l.decisionComment ?? null,
        decidedAt: l.decidedAt ?? null,
        document: l.document ? withUrls([l.document])[0] : null,
        appliedAt: l.createdAt,
      })),
    );
  }),
);

router.post(
  '/',
  attachmentUpload.single('document'),
  ah(async (req, res) => {
    const who = ctx(req);
    const b = parse(
      z.object({ type: z.string().trim().min(1), from: zDate, to: zDate, reason: z.string().trim().min(3).max(1000) }),
      req.body,
    );
    if (b.to < b.from) throw badRequest('The end date is before the start date');
    if (eachDate(b.from, b.to).length > 60) throw badRequest('A single request can be at most 60 days');

    const school = await School.findById(who.schoolId).select('settings.leaveTypes').lean();
    if (!school?.settings.leaveTypes.includes(b.type)) throw badRequest('Unknown leave type');

    const overlap = await LeaveRequest.exists({
      schoolId: who.schoolId,
      teacherId: who.userId,
      status: { $in: ['pending', 'approved'] },
      from: { $lte: b.to },
      to: { $gte: b.from },
    });
    if (overlap) throw conflict('You already have leave applied for some of these dates');

    const document = req.file
      ? await saveFile(req.file.buffer, { folder: `leave/${who.schoolId.toString()}`, originalName: req.file.originalname, mime: req.file.mimetype })
      : undefined;
    const leave = await LeaveRequest.create({ schoolId: who.schoolId, teacherId: who.userId, ...b, document });

    await notifyUsers({
      schoolId: who.schoolId,
      userIds: await adminIds(who.schoolId),
      type: 'leave_requested',
      title: 'Leave request',
      body: `${who.name}: ${b.type} leave ${b.from} to ${b.to}`,
      data: { leaveId: leave._id.toString() },
    });
    ok(res, { id: leave._id.toString(), status: leave.status }, 201);
  }),
);

/** Pending requests can be cancelled; approved ones only before they start. */
router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const who = ctx(req);
    const leave = await LeaveRequest.findOne({ _id: oid(req.params.id), schoolId: who.schoolId, teacherId: who.userId });
    if (!leave) throw notFound('Leave request not found');
    const canCancel = leave.status === 'pending' || (leave.status === 'approved' && leave.from > todayISO());
    if (!canCancel) throw badRequest('This request can no longer be cancelled');
    const wasApproved = leave.status === 'approved';
    leave.status = 'cancelled';
    await leave.save();
    if (wasApproved) {
      await notifyUsers({
        schoolId: who.schoolId,
        userIds: await adminIds(who.schoolId),
        type: 'leave_cancelled',
        title: 'Leave cancelled',
        body: `${who.name} cancelled approved leave ${leave.from} to ${leave.to}`,
      });
    }
    ok(res, { id: leave._id.toString(), status: leave.status });
  }),
);

export default router;
