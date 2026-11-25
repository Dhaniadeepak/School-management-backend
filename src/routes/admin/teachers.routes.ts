import { Router } from 'express';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { TeacherProfile, User } from '../../models';
import { notifyUsers } from '../../services/notifications';
import { badRequest, notFound } from '../../utils/errors';
import { ah, oid, ok, parse } from '../../utils/http';

/** A3: review teacher requests: approve, reject with reason, deactivate. */
const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'deactivated']).optional() }), req.query);
    const users = await User.find({ schoolId, role: 'teacher', ...(status ? { status } : {}) }).sort({ name: 1 }).lean();
    const profiles = await TeacherProfile.find({ schoolId, userId: { $in: users.map((u) => u._id) } }).lean();
    const approvers = await User.find({ _id: { $in: profiles.map((p) => p.decidedBy).filter(Boolean) } }).select('name').lean();

    ok(
      res,
      users.map((u) => {
        const p = profiles.find((x) => x.userId.equals(u._id));
        return {
          id: u._id.toString(),
          name: u.name,
          phone: u.phone,
          status: u.status,
          subjects: p?.subjects ?? [],
          qualification: p?.qualification,
          rejectionReason: p?.rejectionReason,
          decidedAt: p?.decidedAt,
          decidedBy: approvers.find((a) => p?.decidedBy && a._id.equals(p.decidedBy))?.name,
          registeredAt: u.createdAt,
        };
      }),
    );
  }),
);

async function loadTeacher(schoolId: ReturnType<typeof ctx>['schoolId'], id: unknown) {
  const user = await User.findOne({ _id: oid(id), schoolId, role: 'teacher' });
  if (!user) throw notFound('Teacher not found');
  return user;
}

router.post(
  '/:id/approve',
  ah(async (req, res) => {
    const who = ctx(req);
    const { subjects } = parse(z.object({ subjects: z.array(z.string().trim().min(1)).max(10).optional() }), req.body ?? {});
    const user = await loadTeacher(who.schoolId, req.params.id);
    if (user.status === 'approved') throw badRequest('Teacher is already approved');

    user.status = 'approved';
    await user.save();
    await TeacherProfile.updateOne(
      { userId: user._id, schoolId: who.schoolId },
      { $set: { decidedBy: who.userId, decidedAt: new Date(), ...(subjects ? { subjects } : {}) }, $unset: { rejectionReason: 1 } },
      { upsert: true },
    );
    await notifyUsers({
      schoolId: who.schoolId,
      userIds: [user._id],
      type: 'account_approved',
      title: 'Your account is approved',
      body: 'The school office has approved your account. You can now see your timetable and classes.',
    });
    ok(res, { id: user._id.toString(), status: user.status });
  }),
);

router.post(
  '/:id/reject',
  ah(async (req, res) => {
    const who = ctx(req);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const user = await loadTeacher(who.schoolId, req.params.id);
    if (user.status !== 'pending') throw badRequest('Only pending requests can be rejected');

    user.status = 'rejected';
    await user.save();
    await TeacherProfile.updateOne(
      { userId: user._id, schoolId: who.schoolId },
      { $set: { decidedBy: who.userId, decidedAt: new Date(), rejectionReason: reason } },
    );
    await notifyUsers({
      schoolId: who.schoolId,
      userIds: [user._id],
      type: 'account_rejected',
      title: 'Your request was not approved',
      body: reason,
    });
    ok(res, { id: user._id.toString(), status: user.status });
  }),
);

router.post(
  '/:id/deactivate',
  ah(async (req, res) => {
    const who = ctx(req);
    const user = await loadTeacher(who.schoolId, req.params.id);
    user.status = 'deactivated';
    user.tokenVersion += 1; // signs the teacher out everywhere
    await user.save();
    await TeacherProfile.updateOne({ userId: user._id, schoolId: who.schoolId }, { $set: { decidedBy: who.userId, decidedAt: new Date() } });
    ok(res, { id: user._id.toString(), status: user.status });
  }),
);

router.post(
  '/:id/reactivate',
  ah(async (req, res) => {
    const who = ctx(req);
    const user = await loadTeacher(who.schoolId, req.params.id);
    if (user.status !== 'deactivated') throw badRequest('Only deactivated teachers can be reactivated');
    user.status = 'approved';
    await user.save();
    ok(res, { id: user._id.toString(), status: user.status });
  }),
);

export default router;
