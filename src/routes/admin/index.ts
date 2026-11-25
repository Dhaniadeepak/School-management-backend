import { Router } from 'express';
import { authenticate, ctx, requireRole } from '../../middleware/auth';
import { User } from '../../models';
import { ah, ok } from '../../utils/http';
import announcements from './announcements.routes';
import attendance from './attendance.routes';
import classes from './classes.routes';
import dashboard from './dashboard.routes';
import fees from './fees.routes';
import leave from './leave.routes';
import settings from './settings.routes';
import students from './students.routes';
import teachers from './teachers.routes';
import timetable from './timetable.routes';

/** Admin website API. Every handler filters by the admin's own school. */
const router = Router();
router.use(authenticate, requireRole('admin'));

router.use('/dashboard', dashboard);
router.use('/teachers', teachers);
router.use('/classes', classes);
router.use('/students', students);
router.use('/timetable', timetable);
router.use('/leave', leave);
router.use('/announcements', announcements);
router.use('/fees', fees);
router.use('/attendance', attendance);
router.use('/settings', settings);

/** Approved teachers, for pickers (timetable, class teacher, substitutions). */
router.get(
  '/teacher-options',
  ah(async (req, res) => {
    const teachers = await User.find({ schoolId: ctx(req).schoolId, role: 'teacher', status: 'approved' })
      .select('name')
      .sort({ name: 1 })
      .lean();
    ok(res, teachers.map((t) => ({ id: t._id.toString(), name: t.name })));
  }),
);

export default router;
