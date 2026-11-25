import { env } from '../config/env';

/** Sends a one-time code by SMS. MSG91 needs a DLT-approved OTP template. */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (env.SMS_PROVIDER === 'console') {
    // eslint-disable-next-line no-console
    console.log(`[sms] OTP for ${phone}: ${code}`);
    return;
  }

  if (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID) {
    throw new Error('MSG91 is selected but MSG91_AUTH_KEY / MSG91_OTP_TEMPLATE_ID are not set');
  }
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', env.MSG91_OTP_TEMPLATE_ID);
  url.searchParams.set('mobile', `91${phone}`);
  url.searchParams.set('otp', code);
  const res = await fetch(url, { method: 'POST', headers: { authkey: env.MSG91_AUTH_KEY } });
  if (!res.ok) throw new Error(`MSG91 error ${res.status}: ${await res.text()}`);
}
