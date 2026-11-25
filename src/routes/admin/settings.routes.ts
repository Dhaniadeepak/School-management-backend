import { Router } from 'express';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { AuditLog, School, User } from '../../models';
import { badRequest, notFound } from '../../utils/errors';
import { ah, ok, parse, zDate, zTime } from '../../utils/http';

/** School profile, periods, working days, leave types, installments, holidays, audit log. */
const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const school = await School.findById(ctx(req).schoolId).lean();
    if (!school) throw notFound('School not found');
    ok(res, {
      name: school.name,
      address: school.address ?? '',
      phone: school.phone ?? '',
      code: school.code,
      settings: school.settings,
      holidays: [...school.holidays].sort((a, b) => a.date.localeCompare(b.date)),
    });
  }),
);

router.patch(
  '/',
  ah(async (req, res) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        address: z.string().trim().max(300).optional(),
        phone: z.string().trim().max(20).optional(),
        settings: z
          .object({
            workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
            periods: z.array(z.object({ number: z.number().int().min(1).max(20), start: zTime, end: zTime })).min(1).max(20),
            attendanceEditWindowHours: z.number().int().min(1).max(168),
            leaveTypes: z.array(z.string().trim().min(1).max(30)).min(1).max(15),
            allowInstallments: z.boolean(),
            academicYear: z.string().regex(/^\d{4}-\d{2}$/),
          })
          .partial()
          .optional(),
      }),
      req.body,
    );
    if (b.settings?.periods) {
      const nums = b.settings.periods.map((p) => p.number);
      if (new Set(nums).size !== nums.length) throw badRequest('Period numbers must be different');
      if (b.settings.periods.some((p) => p.start >= p.end)) throw badRequest('Each period must end after it starts');
    }
    const school = await School.findById(ctx(req).schoolId);
    if (!school) throw notFound('School not found');
    if (b.name !== undefined) school.name = b.name;
    if (b.address !== undefined) school.address = b.address;
    if (b.phone !== undefined) school.phone = b.phone;
    if (b.settings) Object.assign(school.settings, b.settings);
    await school.save();
    ok(res, { saved: true });
  }),
);

router.post(
  '/holidays',
  ah(async (req, res) => {
    const b = parse(z.object({ date: zDate, name: z.string().trim().min(2).max(80) }), req.body);
    await School.updateOne({ _id: ctx(req).schoolId }, { $pull: { holidays: { date: b.date } } });
    await School.updateOne({ _id: ctx(req).schoolId }, { $push: { holidays: b } });
    ok(res, b, 201);
  }),
);

router.delete(
  '/holidays/:date',
  ah(async (req, res) => {
    const date = parse(zDate, req.params.date);
    await School.updateOne({ _id: ctx(req).schoolId }, { $pull: { holidays: { date } } });
    ok(res, { deleted: true });
  }),
);

/** X4 (early): who changed attendance or fees and when. */
router.get(
  '/audit-log',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const q = parse(z.object({ entity: z.string().optional(), limit: z.coerce.number().min(1).max(500).default(100) }), req.query);
    const items = await AuditLog.find({ schoolId, ...(q.entity ? { entity: q.entity } : {}) }).sort({ createdAt: -1 }).limit(q.limit).lean();
    const users = await User.find({ _id: { $in: items.map((i) => i.userId) } }).select('name role').lean();
    ok(
      res,
      items.map((i) => ({
        id: i._id.toString(),
        at: i.createdAt,
        user: users.find((u) => u._id.equals(i.userId))?.name ?? '',
        action: i.action,
        entity: i.entity,
        entityId: i.entityId,
        oldValue: i.oldValue,
        newValue: i.newValue,
      })),
    );
  }),
);

export default router;
