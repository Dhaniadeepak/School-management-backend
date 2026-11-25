import bcrypt from 'bcryptjs';
import { Router } from 'express';
import type { HydratedDocument } from 'mongoose';
import { z } from 'zod';
import { authenticate, ctx } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimits';
import { School, TeacherProfile, User, type IUser } from '../models';
import { adminIds, notifyUsers } from '../services/notifications';
import { sendOtp, verifyOtp } from '../services/otp';
import { issueTokens, verifyRefreshToken } from '../services/tokens';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../utils/errors';
import { ah, ok, parse } from '../utils/http';
import { normalizePhone } from '../utils/phone';

const router = Router();
router.use(authLimiter);

const MAX_WRONG_PASSWORDS = 5;
const LOCK_MINUTES = 15;

const zPhone = z.string().transform((v, c) => {
  const p = normalizePhone(v);
  if (!p) {
    c.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit mobile number' });
    return z.NEVER;
  }
  return p;
});
const zPassword = z.string().min(8, 'Password must be at least 8 characters').max(100);

export async function publicUser(user: Pick<HydratedDocument<IUser>, '_id' | 'name' | 'role' | 'status' | 'phone' | 'email' | 'schoolId'>) {
  const school = await School.findById(user.schoolId).select('name code').lean();
  return {
    id: user._id.toString(),
    name: user.name,
    role: user.role,
    status: user.status,
    phone: user.phone,
    email: user.email,
    schoolId: user.schoolId.toString(),
    schoolName: school?.name ?? '',
  };
}

/** Password check with a 15-minute lock after 5 wrong attempts. */
async function checkPassword(user: HydratedDocument<IUser>, password: string): Promise<void> {
  if (user.lockUntil && user.lockUntil > new Date()) {
    const mins = Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000);
    throw new AppError(423, `Too many wrong attempts. Try again in ${mins} minute(s) or reset your password.`, 'LOCKED');
  }
  const valid = !!user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
  if (!valid) {
    user.failedLoginCount += 1;
    if (user.failedLoginCount >= MAX_WRONG_PASSWORDS) {
      user.failedLoginCount = 0;
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    }
    await user.save();
    throw unauthorized('Wrong login details');
  }
  user.failedLoginCount = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();
}

async function loginResponse(user: HydratedDocument<IUser>) {
  return { ...issueTokens(user), user: await publicUser(user) };
}

// ---------- Teacher: register (T1) and login (T2) ----------
router.post(
  '/teacher/register',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        phone: zPhone,
        password: zPassword,
        schoolCode: z.string().trim().min(3).max(20),
        subjects: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
        qualification: z.string().trim().max(100).optional(),
      }),
      req.body,
    );

    const school = await School.findOne({ code: body.schoolCode.toUpperCase() });
    if (!school) throw notFound('School code not found. Please check with the school office.');
    if (await User.exists({ role: 'teacher', phone: body.phone })) {
      throw conflict('A teacher account with this phone number already exists');
    }

    const user = await User.create({
      schoolId: school._id,
      role: 'teacher',
      name: body.name,
      phone: body.phone,
      passwordHash: await bcrypt.hash(body.password, 12),
      status: 'pending',
    });
    await TeacherProfile.create({
      schoolId: school._id,
      userId: user._id,
      subjects: body.subjects,
      qualification: body.qualification,
    });
    await notifyUsers({
      schoolId: school._id,
      userIds: await adminIds(school._id),
      type: 'teacher_registered',
      title: 'New teacher request',
      body: `${user.name} has asked to join. Please review in Teacher approvals.`,
      data: { teacherId: user._id.toString() },
    });
    ok(res, await loginResponse(user), 201);
  }),
);

router.post(
  '/teacher/login',
  ah(async (req, res) => {
    const body = parse(z.object({ phone: zPhone, password: z.string().min(1) }), req.body);
    const user = await User.findOne({ role: 'teacher', phone: body.phone }).select('+passwordHash');
    if (!user) throw unauthorized('Wrong login details');
    await checkPassword(user, body.password);
    if (user.status === 'deactivated') throw new AppError(403, 'This account has been deactivated', 'DEACTIVATED');
    ok(res, await loginResponse(user));
  }),
);

// ---------- Admin login (A1): email or phone + password ----------
router.post(
  '/admin/login',
  ah(async (req, res) => {
    const body = parse(z.object({ login: z.string().trim().min(3), password: z.string().min(1) }), req.body);
    const phone = normalizePhone(body.login);
    const filter = phone ? { role: 'admin' as const, phone } : { role: 'admin' as const, email: body.login.toLowerCase() };
    const users = await User.find(filter).select('+passwordHash').limit(2);
    if (users.length !== 1) throw unauthorized('Wrong login details');
    const user = users[0];
    await checkPassword(user, body.password);
    if (user.status !== 'approved') throw new AppError(403, 'This account is not active', 'DEACTIVATED');
    ok(res, await loginResponse(user));
  }),
);

// ---------- Parent login by OTP (P1) ----------
router.post(
  '/parent/otp/request',
  ah(async (req, res) => {
    const { phone } = parse(z.object({ phone: zPhone }), req.body);
    const exists = await User.exists({ role: 'parent', phone, status: 'approved' });
    if (!exists) {
      throw notFound('This number is not registered with any school. Please contact your school office.');
    }
    await sendOtp(phone, 'parent_login');
    ok(res, { sent: true, expiresInSeconds: 300 });
  }),
);

router.post(
  '/parent/otp/verify',
  ah(async (req, res) => {
    const body = parse(
      z.object({ phone: zPhone, code: z.string().regex(/^\d{6}$/), schoolId: z.string().optional() }),
      req.body,
    );
    const accounts = await User.find({ role: 'parent', phone: body.phone, status: 'approved' });
    if (accounts.length === 0) throw notFound('This number is not registered with any school');

    // A parent with children in two schools has two accounts: let them pick one after the code.
    // The code is checked but kept, so the parent sends it again with the chosen school.
    if (accounts.length > 1 && !body.schoolId) {
      await verifyOtp(body.phone, 'parent_login', body.code, false);
      const schools = await School.find({ _id: { $in: accounts.map((a) => a.schoolId) } }).select('name').lean();
      return ok(res, {
        needsSchool: true,
        schools: schools.map((s) => ({ id: s._id.toString(), name: s.name })),
      });
    }

    await verifyOtp(body.phone, 'parent_login', body.code);
    const user = accounts.length === 1 ? accounts[0] : accounts.find((a) => a.schoolId.toString() === body.schoolId);
    if (!user) throw notFound('Account not found for this school');
    user.lastLoginAt = new Date();
    await user.save();
    ok(res, await loginResponse(user));
  }),
);

// ---------- Forgot password (teacher/admin) by SMS code ----------
router.post(
  '/password/forgot',
  ah(async (req, res) => {
    const body = parse(z.object({ role: z.enum(['teacher', 'admin']), phone: zPhone }), req.body);
    const exists = await User.exists({ role: body.role, phone: body.phone });
    // Always answer the same way so the endpoint cannot be used to find accounts.
    if (exists) await sendOtp(body.phone, 'password_reset');
    ok(res, { sent: true });
  }),
);

router.post(
  '/password/reset',
  ah(async (req, res) => {
    const body = parse(
      z.object({ role: z.enum(['teacher', 'admin']), phone: zPhone, code: z.string().regex(/^\d{6}$/), newPassword: zPassword }),
      req.body,
    );
    const user = await User.findOne({ role: body.role, phone: body.phone });
    if (!user) throw badRequest('This code has expired. Please request a new one.');
    await verifyOtp(body.phone, 'password_reset', body.code);
    user.passwordHash = await bcrypt.hash(body.newPassword, 12);
    user.failedLoginCount = 0;
    user.lockUntil = undefined;
    user.tokenVersion += 1; // signs out every device
    await user.save();
    ok(res, { reset: true });
  }),
);

// ---------- Tokens ----------
router.post(
  '/refresh',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    let claims;
    try {
      claims = verifyRefreshToken(refreshToken);
    } catch {
      throw unauthorized('Your session has expired');
    }
    const user = await User.findById(claims.sub);
    if (!user || user.tokenVersion !== claims.tv || user.status === 'deactivated') {
      throw unauthorized('Your session has expired');
    }
    ok(res, { ...issueTokens(user), user: await publicUser(user) });
  }),
);

router.post(
  '/logout',
  authenticate,
  ah(async (req, res) => {
    const { userId } = ctx(req);
    const token = typeof req.body?.fcmToken === 'string' ? req.body.fcmToken : undefined;
    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, ...(token ? { $pull: { fcmTokens: token } } : {}) },
    );
    ok(res, { loggedOut: true });
  }),
);

export default router;
