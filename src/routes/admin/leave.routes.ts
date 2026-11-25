import { Router } from 'express';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { LeaveRequest, User } from '../../models';
import { notifyUsers } from '../../services/notifications';
import { periodsNeedingCover } from '../../services/schedule';
import { withUrls } from '../../services/storage';
import { eachDate, todayISO } from '../../utils/dates';
import { badRequest, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zDate } from '../../utils/http';

/** A6: approve or reject teacher leave; show the periods that then need cover. */
const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }), req.query);
    const items = await LeaveRequest.find({ schoolId, ...(status ? { status } : {}) }).sort({ from: -1 }).limit(200).lean();
    const users = await User.find({ _id: { $in: items.flatMap((l) => [l.teacherId, l.decidedBy]).filter(Boolean) } }).select('name').lean();
    const name = (id?: { equals(o: unknown): boolean }) => (id ? users.find((u) => id.equals(u._id))?.name ?? '' : '');
    ok(
      res,
      items.map((l) => ({
        id: l._id.toString(),
        teacherId: l.teacherId.toString(),
        teacherName: name(l.teacherId),
        type: l.type,
        from: l.from,
        to: l.to,
        days: eachDate(l.from, l.to).length,
        reason: l.reason,
        status: l.status,
        document: l.document ? withUrls([l.document])[0] : null,
        decidedBy: name(l.decidedBy),
        decidedAt: l.decidedAt,
        decisionComment: l.decisionComment,
        appliedAt: l.createdAt,
      })),
    );
  }),
);

router.post(
  '/:id/decide',
  ah(async (req, res) => {
    const who = ctx(req);
    const body = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().trim().max(300).optional() }), req.body);
    const leave = await LeaveRequest.findOne({ _id: oid(req.params.id), schoolId: who.schoolId });
    if (!leave) throw notFound('Leave request not found');
    if (leave.status !== 'pending') throw badRequest(`This request is already ${leave.status}`);

    leave.status = body.decision;
    leave.decidedBy = who.userId;
    leave.decidedAt = new Date();
    leave.decisionComment = body.comment;
    await leave.save();

    await notifyUsers({
      schoolId: who.schoolId,
      userIds: [leave.teacherId],
      type: 'leave_decided',
      title: body.decision === 'approved' ? 'Leave approved' : 'Leave not approved',
      body: `${leave.type} leave ${leave.from} to ${leave.to}${body.comment ? `: ${body.comment}` : ''}`,
      data: { leaveId: leave._id.toString() },
    });

    // Periods that now need a substitute (first 31 days of the leave)
    const cover =
      body.decision === 'approved'
        ? (await Promise.all(eachDate(leave.from, leave.to).slice(0, 31).map((d) => periodsNeedingCover(who.schoolId, d))))
            .flat()
            .filter((p) => p.teacherId === leave.teacherId.toString())
        : [];
    ok(res, { id: leave._id.toString(), status: leave.status, cover });
  }),
);

router.get(
  '/cover',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { date } = parse(z.object({ date: zDate.default(() => todayISO()) }), req.query);
    ok(res, await periodsNeedingCover(schoolId, date));
  }),
);

export default router;
