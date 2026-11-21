/**
 * Masks an email for roles without PII access: first letter of the local part and of the
 * domain, plus the top-level domain. `jane.doe@example.com` becomes `j***@e***.com`.
 *
 * @param email Plain email.
 * @returns Masked email.
 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}

/**
 * Masks a phone number to its last four digits: `+15551234567` becomes `+*******4567`.
 *
 * @param phone E.164 number.
 * @returns Masked number.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `+${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Shown in place of a date of birth for roles without PII access. */
export const MASKED_DATE = '****-**-**';
