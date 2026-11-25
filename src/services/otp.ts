import crypto from 'crypto';
import { env } from '../config/env';
import { Otp, type IOtp } from '../models';
import { badRequest, tooMany } from '../utils/errors';
import { sendOtpSms } from './sms';

const VALID_MINUTES = 5;
const MAX_SENDS_PER_15_MIN = 3;
const MAX_WRONG_ATTEMPTS = 5;

const hash = (phone: string, code: string) =>
  crypto.createHmac('sha256', env.OTP_SECRET).update(`${phone}:${code}`).digest('hex');

/** Creates a 6-digit code valid for 5 minutes and sends it by SMS. */
export async function sendOtp(phone: string, purpose: IOtp['purpose']): Promise<void> {
  const recent = await Otp.countDocuments({
    phone,
    purpose,
    createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) },
  });
  if (recent >= MAX_SENDS_PER_15_MIN) throw tooMany('Too many codes requested. Please try again in 15 minutes.');

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await Otp.create({
    phone,
    purpose,
    codeHash: hash(phone, code),
    expiresAt: new Date(Date.now() + VALID_MINUTES * 60 * 1000),
  });
  await sendOtpSms(phone, code);
}

/**
 * Checks the latest unused code for this phone and purpose. Consumes it unless
 * `consume` is false (used when a parent must still pick a school with the same code).
 */
export async function verifyOtp(phone: string, purpose: IOtp['purpose'], code: string, consume = true): Promise<void> {
  const otp = await Otp.findOne({ phone, purpose, consumedAt: { $exists: false } }).sort({ createdAt: -1 });
  if (!otp || otp.expiresAt < new Date()) throw badRequest('This code has expired. Please request a new one.');
  if (otp.attempts >= MAX_WRONG_ATTEMPTS) throw tooMany('Too many wrong attempts. Please request a new code.');

  const a = Buffer.from(hash(phone, code));
  const b = Buffer.from(otp.codeHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    otp.attempts += 1;
    await otp.save();
    throw badRequest('Wrong code');
  }
  if (consume) {
    otp.consumedAt = new Date();
    await otp.save();
  }
}
