import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ClassSection, FeeDue, FeeStructure, ParentStudent, School, Student, User } from '../src/models';
import { signAccessToken } from '../src/services/tokens';

/**
 * School isolation: a user from one school must never read another school's data,
 * even by guessing an ID. Also: parents only see their own children.
 */
let mongo: MongoMemoryServer;
const app = createApp();

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function makeSchool(code: string) {
  const school = await School.create({ name: `School ${code}`, code, settings: { periods: [{ number: 1, start: '08:00', end: '08:40' }] } });
  const admin = await User.create({ schoolId: school._id, role: 'admin', name: `Admin ${code}`, email: `${code}@x.test` });
  const teacher = await User.create({ schoolId: school._id, role: 'teacher', name: `Teacher ${code}`, phone: code === 'AAA' ? '9000000101' : '9000000102' });
  const cls = await ClassSection.create({ schoolId: school._id, name: '6', section: 'A' });
  const student = await Student.create({ schoolId: school._id, admissionNo: 'S1', name: `Kid ${code}`, classId: cls._id });
  const parent = await User.create({ schoolId: school._id, role: 'parent', name: `Parent ${code}`, phone: code === 'AAA' ? '9800000101' : '9800000102' });
  await ParentStudent.create({ schoolId: school._id, parentId: parent._id, studentId: student._id });
  const fs = await FeeStructure.create({ schoolId: school._id, classId: cls._id, academicYear: '2026-27', heads: [{ name: 'Tuition', amount: 100 }], total: 100, dueDate: '2026-04-01', createdBy: admin._id });
  const due = await FeeDue.create({ schoolId: school._id, studentId: student._id, classId: cls._id, feeStructureId: fs._id, academicYear: '2026-27', installmentNo: 0, label: 'Annual fee', amount: 100, dueDate: '2026-04-01' });
  return { school, admin, teacher, cls, student, parent, fs, due };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const a = await makeSchool('AAA');
  const b = await makeSchool('BBB');
  tokens.adminA = signAccessToken(a.admin);
  tokens.parentA = signAccessToken(a.parent);
  tokens.teacherA = signAccessToken(a.teacher);
  ids.studentB = b.student._id.toString();
  ids.classB = b.cls._id.toString();
  ids.teacherB = b.teacher._id.toString();
  ids.fsB = b.fs._id.toString();
  ids.dueB = b.due._id.toString();
  ids.studentA = a.student._id.toString();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('school isolation', () => {
  it('admin lists only their own students', async () => {
    const res = await request(app).get('/api/v1/admin/students').set(auth(tokens.adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((s: { name: string }) => s.name)).toEqual(['Kid AAA']);
  });

  it("admin cannot edit another school's student by id", async () => {
    const res = await request(app).patch(`/api/v1/admin/students/${ids.studentB}`).set(auth(tokens.adminA)).send({ name: 'Hacked' });
    expect(res.status).toBe(404);
    expect((await Student.findById(ids.studentB))?.name).toBe('Kid BBB');
  });

  it("admin cannot approve another school's teacher", async () => {
    const res = await request(app).post(`/api/v1/admin/teachers/${ids.teacherB}/deactivate`).set(auth(tokens.adminA));
    expect(res.status).toBe(404);
  });

  it("admin cannot read another school's class attendance", async () => {
    const res = await request(app).get(`/api/v1/admin/attendance?classId=${ids.classB}`).set(auth(tokens.adminA));
    expect(res.status).toBe(400);
  });

  it("admin cannot generate dues on another school's fee structure", async () => {
    const res = await request(app).post(`/api/v1/admin/fees/structures/${ids.fsB}/generate-dues`).set(auth(tokens.adminA));
    expect(res.status).toBe(404);
  });

  it('parent sees only their own child', async () => {
    const res = await request(app).get('/api/v1/parent/children').set(auth(tokens.parentA));
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([ids.studentA]);
  });

  it("parent cannot open another school's child by guessing the id", async () => {
    for (const path of ['attendance', 'homework', 'fees']) {
      const res = await request(app).get(`/api/v1/parent/children/${ids.studentB}/${path}`).set(auth(tokens.parentA));
      expect(res.status).toBe(404);
    }
  });

  it("parent cannot pay another child's fee", async () => {
    const res = await request(app)
      .post(`/api/v1/parent/children/${ids.studentA}/fees/orders`)
      .set(auth(tokens.parentA))
      .send({ dueIds: [ids.dueB] });
    expect(res.status).toBe(400);
  });

  it('pending teacher sees no school data', async () => {
    await User.updateOne({ role: 'teacher', phone: '9000000101' }, { $set: { status: 'pending' } });
    const res = await request(app).get('/api/v1/teacher/classes').set(auth(tokens.teacherA));
    expect(res.status).toBe(403);
  });

  it('roles cannot use each other’s APIs', async () => {
    const res = await request(app).get('/api/v1/admin/dashboard').set(auth(tokens.parentA));
    expect(res.status).toBe(403);
  });
});
