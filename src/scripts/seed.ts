/* eslint-disable no-console */
import bcrypt from 'bcryptjs';
import { Types, type Model } from 'mongoose';
import { connectDB, disconnectDB } from '../config/db';
import {
  Announcement,
  Attendance,
  AuditLog,
  ClassSection,
  FeeDue,
  FeeStructure,
  Homework,
  LeaveRequest,
  Notification,
  ParentStudent,
  Payment,
  School,
  Student,
  Substitution,
  TeacherProfile,
  TimetableEntry,
  User,
} from '../models';

/**
 * Creates a demo school with an admin, teachers, classes, students, parents, a published
 * timetable, fee structures and an event. Run with: npm run seed
 * Re-running replaces the demo school's data.
 */
const CODE = 'DEMO01';

async function main() {
  await connectDB();

  const old = await School.findOne({ code: CODE });
  if (old) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const models: Model<any>[] = [
      Announcement, Attendance, AuditLog, ClassSection, FeeDue, FeeStructure, Homework, LeaveRequest,
      Notification, ParentStudent, Payment, Student, Substitution, TeacherProfile, TimetableEntry, User,
    ];
    for (const m of models) await m.deleteMany({ schoolId: old._id });
    await old.deleteOne();
    console.log('Removed previous demo school');
  }

  const periods = [
    ['08:00', '08:40'], ['08:40', '09:20'], ['09:20', '10:00'], ['10:00', '10:40'],
    ['11:00', '11:40'], ['11:40', '12:20'], ['12:20', '13:00'], ['13:00', '13:40'],
  ].map(([start, end], i) => ({ number: i + 1, start, end }));

  const school = await School.create({
    name: 'Green Valley Public School',
    address: 'Sector 70, Mohali, Punjab',
    phone: '0172-0000000',
    code: CODE,
    settings: {
      workingDays: [1, 2, 3, 4, 5, 6],
      periods,
      attendanceMode: 'daily',
      attendanceEditWindowHours: 24,
      leaveTypes: ['Casual', 'Sick', 'Earned'],
      allowInstallments: true,
      academicYear: '2026-27',
    },
    holidays: [
      { date: '2026-12-25', name: 'Christmas' },
      { date: '2027-01-26', name: 'Republic Day' },
    ],
  });
  const schoolId = school._id;

  const adminPass = await bcrypt.hash('Admin@1234', 12);
  const teacherPass = await bcrypt.hash('Teacher@1234', 12);

  const admin = await User.create({
    schoolId, role: 'admin', name: 'Priya Office', email: 'admin@demo.school', phone: '9000000001', passwordHash: adminPass,
  });

  const teacherData = [
    { name: 'Anita Verma', phone: '9000000011', subject: 'Maths' },
    { name: 'Rahul Mehta', phone: '9000000012', subject: 'Science' },
    { name: 'Simran Kaur', phone: '9000000013', subject: 'English' },
  ];
  // Remove any demo teacher phones left in other schools by older runs
  await User.deleteMany({ role: 'teacher', phone: { $in: [...teacherData.map((t) => t.phone), '9000000014'] } });

  const teachers: { name: string; phone: string; subject: string; id: Types.ObjectId }[] = [];
  for (const t of teacherData) {
    const u = await User.create({ schoolId, role: 'teacher', name: t.name, phone: t.phone, passwordHash: teacherPass, status: 'approved' });
    await TeacherProfile.create({ schoolId, userId: u._id, subjects: [t.subject], decidedBy: admin._id, decidedAt: new Date() });
    teachers.push({ ...t, id: u._id });
  }
  const pending = await User.create({
    schoolId, role: 'teacher', name: 'Vikram Singh', phone: '9000000014', passwordHash: teacherPass, status: 'pending',
  });
  await TeacherProfile.create({ schoolId, userId: pending._id, subjects: ['Hindi'], qualification: 'M.A., B.Ed.' });

  const classes: { _id: Types.ObjectId }[] = [];
  for (const [i, [name, section]] of [['6', 'A'], ['6', 'B'], ['7', 'A']].entries()) {
    classes.push(await ClassSection.create({ schoolId, name, section, classTeacherId: teachers[i].id }));
  }

  // Students and parents. The first parent has two children (6-A and 7-A) to show the child switcher.
  const first = ['Aarav', 'Diya', 'Kabir', 'Ishita', 'Vihaan', 'Anaya', 'Arjun', 'Meera'];
  const last = ['Sharma', 'Gill', 'Bansal', 'Sandhu', 'Arora', 'Kapoor', 'Malhotra', 'Grewal'];
  let parentSeq = 1;
  const parentByPhone = new Map<string, Types.ObjectId>();
  const getParent = async (phone: string, name: string) => {
    let id = parentByPhone.get(phone);
    if (!id) {
      const p = await User.create({ schoolId, role: 'parent', name, phone, status: 'approved' });
      id = p._id;
      parentByPhone.set(phone, id);
    }
    return id;
  };

  let adm = 1001;
  for (const [ci, cls] of classes.entries()) {
    for (let r = 0; r < 8; r++) {
      const surname = last[(r + ci) % last.length];
      const student = await Student.create({
        schoolId, admissionNo: `A${adm++}`, name: `${first[(r + ci * 3) % first.length]} ${surname}`, classId: cls._id, rollNo: r + 1,
      });
      const sharedSibling = (ci === 0 || ci === 2) && r === 0;
      const phone = sharedSibling ? '9810000001' : `98100${String(++parentSeq).padStart(5, '0')}`;
      const parentId = await getParent(phone, sharedSibling ? 'Rohit Sharma' : `Parent of ${surname}`);
      await ParentStudent.create({ schoolId, parentId, studentId: student._id, relation: 'Father' });
    }
  }

  // Timetable: teacher i takes class (p + d + i) % 4 in period p on day d; 3 means a free period.
  const entries: Record<string, unknown>[] = [];
  for (let d = 1; d <= 6; d++) {
    for (const [ti, t] of teachers.entries()) {
      let dutyGiven = false;
      for (const p of periods) {
        const idx = (p.number + d + ti) % 4;
        if (idx < 3) {
          entries.push({ teacherId: t.id, day: d, period: p.number, kind: 'class', classId: classes[idx]._id, subject: t.subject, room: `${10 + idx}` });
        } else if (ti === 0 && !dutyGiven) {
          dutyGiven = true;
          entries.push({ teacherId: t.id, day: d, period: p.number, kind: 'duty', note: 'Library duty', room: 'Library' });
        }
      }
    }
  }
  await TimetableEntry.insertMany(entries.map((e) => ({ ...e, schoolId, status: 'draft', version: 0 })));
  await TimetableEntry.insertMany(entries.map((e) => ({ ...e, schoolId, status: 'published', version: 1 })));
  school.timetable = { publishedVersion: 1, publishedAt: new Date(), draftUpdatedAt: new Date(Date.now() - 1000) };
  await school.save();

  // Fees: Rs. 30,000 a year, payable in two installments.
  for (const cls of classes) {
    const fs = await FeeStructure.create({
      schoolId, classId: cls._id, academicYear: '2026-27',
      heads: [{ name: 'Tuition', amount: 24000 }, { name: 'Transport', amount: 6000 }],
      total: 30000, dueDate: '2026-04-15', allowInstallments: true,
      installments: [
        { label: 'Installment 1', dueDate: '2026-04-15', amount: 15000 },
        { label: 'Installment 2', dueDate: '2026-12-15', amount: 15000 },
      ],
      createdBy: admin._id,
    });
    const students = await Student.find({ schoolId, classId: cls._id }).lean();
    await FeeDue.insertMany(
      students.flatMap((s) =>
        fs.installments.map((i, n) => ({
          schoolId, studentId: s._id, classId: cls._id, feeStructureId: fs._id, academicYear: fs.academicYear,
          installmentNo: n + 1, label: i.label, amount: i.amount, dueDate: i.dueDate, status: 'pending',
        })),
      ),
    );
  }

  await Announcement.create({
    schoolId, kind: 'event', title: 'Annual Sports Day', body: 'All students should come in house T-shirts. Parents are welcome.',
    audience: { kind: 'all', classIds: [] }, event: { date: '2026-12-12', time: '09:00', place: 'School ground' },
    publishAt: new Date(), status: 'published', createdBy: admin._id,
  });

  console.log(`
Demo school created: ${school.name} (school code ${CODE})

Admin website   login: admin@demo.school  (or 9000000001)   password: Admin@1234
Teacher portal  phone: 9000000011 / 9000000012 / 9000000013  password: Teacher@1234
                pending teacher (to approve): 9000000014
Parent portal   phone: 9810000001 (two children). The OTP is printed in the API log.
`);
  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
