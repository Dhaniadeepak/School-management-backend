/**
 * Normalises an Indian mobile number to its 10 digits (e.g. "+91 98765-43210" -> "9876543210").
 * Returns null when it is not a valid Indian mobile number.
 */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export const maskPhone = (p: string) => `${p.slice(0, 2)}******${p.slice(-2)}`;
