import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { ClassSection, Student, User, classLabel } from '../../models';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { ah, oid, ok, parse, zId } from '../../utils/http';

/** A4 (part 1): classes and sections. */
const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const classes = await ClassSection.find({ schoolId }).lean();
    const counts = await Student.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { schoolId, active: true } },
      { $group: { _id: '$classId', n: { $sum: 1 } } },
    ]);
    const teachers = await User.find({ _id: { $in: classes.map((c) => c.classTeacherId).filter(Boolean) } }).select('name').lean();

    const rows = classes
      .map((c) => ({
        id: c._id.toString(),
        name: c.name,
        section: c.section,
        label: classLabel(c),
        classTeacherId: c.classTeacherId?.toString() ?? null,
        classTeacherName: teachers.find((t) => c.classTeacherId && t._id.equals(c.classTeacherId))?.name ?? null,
        studentCount: counts.find((x) => x._id.equals(c._id))?.n ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.section.localeCompare(b.section));
    ok(res, rows);
  }),
);

const classBody = z.object({
  name: z.string().trim().min(1).max(20),
  section: z.string().trim().min(1).max(5),
  classTeacherId: zId.nullable().optional(),
});

async function checkTeacher(schoolId: Types.ObjectId, id: string | null | undefined) {
  if (!id) return;
  const exists = await User.exists({ _id: id, schoolId, role: 'teacher', status: 'approved' });
  if (!exists) throw badRequest('Class teacher must be an approved teacher of this school');
}

router.post(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const body = parse(classBody, req.body);
    await checkTeacher(schoolId, body.classTeacherId);
    if (await ClassSection.exists({ schoolId, name: body.name, section: body.section.toUpperCase() })) {
      throw conflict(`Class ${body.name}-${body.section.toUpperCase()} already exists`);
    }
    const c = await ClassSection.create({ schoolId, ...body, classTeacherId: body.classTeacherId ?? undefined });
    ok(res, { id: c._id.toString(), label: classLabel(c) }, 201);
  }),
);

router.patch(
  '/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const body = parse(classBody.partial(), req.body);
    await checkTeacher(schoolId, body.classTeacherId);
    const c = await ClassSection.findOne({ _id: oid(req.params.id), schoolId });
    if (!c) throw notFound('Class not found');
    if (body.name !== undefined) c.name = body.name;
    if (body.section !== undefined) c.section = body.section;
    if (body.classTeacherId !== undefined) c.classTeacherId = body.classTeacherId ? new Types.ObjectId(body.classTeacherId) : undefined;
    await c.save();
    ok(res, { id: c._id.toString(), label: classLabel(c) });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const id = oid(req.params.id);
    if (await Student.exists({ schoolId, classId: id })) throw conflict('Move or remove the students of this class first');
    const r = await ClassSection.deleteOne({ _id: id, schoolId });
    if (r.deletedCount === 0) throw notFound('Class not found');
    ok(res, { deleted: true });
  }),
);

export default router;
