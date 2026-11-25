import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../middleware/auth';
import { excelUpload } from '../../middleware/upload';
import { ClassSection, ParentStudent, Student, User, classLabel } from '../../models';
import { STUDENT_COLUMNS, readStudentRows, studentTemplate } from '../../services/excel';
import { badRequest, conflict, notFound, unprocessable } from '../../utils/errors';
import { ah, oid, ok, parse, zDate, zId } from '../../utils/http';
import { normalizePhone } from '../../utils/phone';

/** A4 (part 2): students, parent links, Excel upload. */
const router = Router();

interface ParentInput {
  name: string;
  phone: string;
  relation?: string;
}

/** Finds or creates the parent account for each phone and links it to the student. */
async function linkParents(schoolId: Types.ObjectId, studentId: Types.ObjectId, parents: ParentInput[]) {
  let created = 0;
  for (const p of parents) {
    let parent = await User.findOne({ schoolId, role: 'parent', phone: p.phone });
    if (!parent) {
      parent = await User.create({ schoolId, role: 'parent', name: p.name, phone: p.phone, status: 'approved' });
      created++;
    }
    await ParentStudent.updateOne(
      { parentId: parent._id, studentId },
      { $set: { schoolId, relation: p.relation || 'Guardian' } },
      { upsert: true },
    );
  }
  return created;
}

const zPhone = z.string().transform((v, c) => {
  const p = normalizePhone(v);
  if (!p) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
    return z.NEVER;
  }
  return p;
});

const parentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: zPhone,
  relation: z.string().trim().max(30).optional(),
});

const studentBody = z.object({
  admissionNo: z.string().trim().min(1).max(30),
  name: z.string().trim().min(2).max(80),
  classId: zId,
  rollNo: z.coerce.number().int().min(1).max(999).optional(),
  gender: z.string().trim().max(10).optional(),
  dob: zDate.optional(),
  parents: z.array(parentSchema).min(1).max(4),
});

async function assertClass(schoolId: Types.ObjectId, classId: string) {
  if (!(await ClassSection.exists({ _id: classId, schoolId }))) throw badRequest('Class not found');
}

router.get(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const q = parse(
      z.object({
        classId: zId.optional(),
        q: z.string().trim().max(50).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = { schoolId };
    if (q.classId) filter.classId = new Types.ObjectId(q.classId);
    if (q.q) {
      const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { admissionNo: rx }];
    }
    const [items, total] = await Promise.all([
      Student.find(filter).sort({ classId: 1, rollNo: 1, name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Student.countDocuments(filter),
    ]);
    const [classes, links] = await Promise.all([
      ClassSection.find({ schoolId, _id: { $in: items.map((s) => s.classId) } }).lean(),
      ParentStudent.find({ schoolId, studentId: { $in: items.map((s) => s._id) } }).lean(),
    ]);
    const parents = await User.find({ _id: { $in: links.map((l) => l.parentId) } }).select('name phone').lean();

    ok(res, {
      total,
      page: q.page,
      items: items.map((s) => ({
        id: s._id.toString(),
        admissionNo: s.admissionNo,
        name: s.name,
        classId: s.classId.toString(),
        className: classLabel(classes.find((c) => c._id.equals(s.classId))),
        rollNo: s.rollNo ?? null,
        gender: s.gender,
        dob: s.dob,
        active: s.active,
        parents: links
          .filter((l) => l.studentId.equals(s._id))
          .map((l) => {
            const p = parents.find((x) => x._id.equals(l.parentId));
            return { name: p?.name ?? '', phone: p?.phone ?? '', relation: l.relation };
          }),
      })),
    });
  }),
);

router.post(
  '/',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const body = parse(studentBody, req.body);
    await assertClass(schoolId, body.classId);
    if (await Student.exists({ schoolId, admissionNo: body.admissionNo })) {
      throw conflict(`Admission number ${body.admissionNo} already exists`);
    }
    const { parents, ...data } = body;
    const student = await Student.create({ schoolId, ...data, classId: new Types.ObjectId(data.classId) });
    await linkParents(schoolId, student._id, parents);
    ok(res, { id: student._id.toString() }, 201);
  }),
);

router.patch(
  '/:id',
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    const body = parse(studentBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const student = await Student.findOne({ _id: oid(req.params.id), schoolId });
    if (!student) throw notFound('Student not found');
    if (body.classId) await assertClass(schoolId, body.classId);
    if (body.admissionNo && body.admissionNo !== student.admissionNo) {
      if (await Student.exists({ schoolId, admissionNo: body.admissionNo })) throw conflict('Admission number already exists');
      student.admissionNo = body.admissionNo;
    }
    if (body.name !== undefined) student.name = body.name;
    if (body.classId) student.classId = new Types.ObjectId(body.classId);
    if (body.rollNo !== undefined) student.rollNo = body.rollNo;
    if (body.gender !== undefined) student.gender = body.gender;
    if (body.dob !== undefined) student.dob = body.dob;
    if (body.active !== undefined) student.active = body.active;
    await student.save();

    if (body.parents) {
      // Replace the parent links with the list given.
      await ParentStudent.deleteMany({ schoolId, studentId: student._id });
      await linkParents(schoolId, student._id, body.parents);
    }
    ok(res, { id: student._id.toString() });
  }),
);

// ---------- Excel template and upload ----------
router.get(
  '/template',
  ah(async (_req, res) => {
    const buf = await studentTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="students-template.xlsx"');
    res.send(buf);
  }),
);

/**
 * Validates every row first. If any row is wrong, nothing is saved and the response lists
 * every problem with its row number. Otherwise all students are created and parents linked.
 */
router.post(
  '/upload',
  excelUpload.single('file'),
  ah(async (req, res) => {
    const { schoolId } = ctx(req);
    if (!req.file) throw badRequest('Choose the filled-in Excel file');
    const rows = await readStudentRows(req.file.buffer);
    if (rows.length === 0) throw unprocessable('The file has no student rows');
    if (rows.length > 5000) throw unprocessable('Upload at most 5000 students at a time');

    const classes = await ClassSection.find({ schoolId }).lean();
    const classByKey = new Map(classes.map((c) => [`${c.name}-${c.section}`.toUpperCase(), c._id]));
    const existing = new Set(
      (await Student.find({ schoolId, admissionNo: { $in: rows.map((r) => r.values.admission_no) } }).select('admissionNo').lean()).map(
        (s) => s.admissionNo,
      ),
    );

    const errors: { row: number; message: string }[] = [];
    const seen = new Map<string, number>();
    const valid: {
      row: number;
      parents: ParentInput[];
      student: { schoolId: Types.ObjectId; admissionNo: string; name: string; classId: Types.ObjectId; rollNo?: number; gender?: string; dob?: string };
    }[] = [];

    for (const { row, values: v } of rows) {
      const rowErrors: string[] = [];
      for (const c of STUDENT_COLUMNS) if (c.required && !v[c.key]) rowErrors.push(`${c.key} is required`);

      const classId = classByKey.get(`${v.class}-${v.section}`.toUpperCase());
      if (v.class && v.section && !classId) rowErrors.push(`class ${v.class}-${v.section} does not exist`);

      if (v.admission_no) {
        if (existing.has(v.admission_no)) rowErrors.push(`admission_no ${v.admission_no} already exists`);
        const first = seen.get(v.admission_no);
        if (first) rowErrors.push(`admission_no ${v.admission_no} is repeated (also on row ${first})`);
        else seen.set(v.admission_no, row);
      }

      const parents: ParentInput[] = [];
      for (const n of [1, 2] as const) {
        const name = v[`parent${n}_name`];
        const rawPhone = v[`parent${n}_phone`];
        if (!rawPhone && !name) continue;
        const phone = normalizePhone(rawPhone);
        if (!phone) rowErrors.push(`parent${n}_phone "${rawPhone}" is not a valid 10-digit mobile number`);
        else parents.push({ name: name || 'Parent', phone, relation: v[`parent${n}_relation`] || undefined });
      }

      const roll = v.roll_no ? Number(v.roll_no) : undefined;
      if (v.roll_no && (!Number.isInteger(roll) || (roll ?? 0) < 1)) rowErrors.push('roll_no must be a whole number');
      if (v.dob && !/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) rowErrors.push('dob must be YYYY-MM-DD');

      if (rowErrors.length || !classId) errors.push({ row, message: rowErrors.join('; ') || 'class is required' });
      else
        valid.push({
          row,
          parents,
          student: {
            schoolId,
            admissionNo: v.admission_no,
            name: v.student_name,
            classId,
            rollNo: roll,
            gender: v.gender || undefined,
            dob: v.dob || undefined,
          },
        });
    }

    if (errors.length) {
      throw unprocessable(`${errors.length} row(s) have problems. Nothing was imported; fix them and upload again.`, {
        errors,
        totalRows: rows.length,
      });
    }

    const created = await Student.insertMany(valid.map((v) => v.student));
    let parentsCreated = 0;
    for (let i = 0; i < created.length; i++) {
      parentsCreated += await linkParents(schoolId, created[i]._id, valid[i].parents);
    }
    ok(res, { created: created.length, parentsCreated }, 201);
  }),
);

export default router;
