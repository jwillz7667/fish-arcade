import { ComplianceBlockedError } from '@reef/errors';
import { z } from 'zod';

import { AUTH_POLICY } from '../auth-policy.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Profile fields collected at signup (spec §5.1). */
export const signupProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[\p{L}\p{N} _.-]+$/u, 'letters, digits, spaces, and _ . - only'),
  dateOfBirth: z
    .string()
    .regex(ISO_DATE, 'must be YYYY-MM-DD')
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    }, 'must be a real date'),
  // Two-letter state code. Which states may sign up is the jurisdiction gate (Step 7).
  stateCode: z.string().regex(/^[A-Z]{2}$/, 'must be a two-letter state code'),
});

/** Parsed signup profile. */
export type SignupProfile = z.infer<typeof signupProfileSchema>;

/**
 * Age in whole years on a date, computed in UTC.
 *
 * @param dateOfBirth `YYYY-MM-DD`, already validated.
 * @param on The date to measure at.
 * @returns Completed years.
 */
export function ageInYears(dateOfBirth: string, on: Date): number {
  const [year, month, day] = dateOfBirth.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) return 0;
  const hasHadBirthday =
    on.getUTCMonth() + 1 > month || (on.getUTCMonth() + 1 === month && on.getUTCDate() >= day);
  return on.getUTCFullYear() - year - (hasHadBirthday ? 0 : 1);
}

/**
 * Spec §5.1 age gate: 18+ by default, or the state's `min_age` where that is higher.
 *
 * @param dateOfBirth `YYYY-MM-DD`.
 * @param now Current time.
 * @param minimumAge The age required; never below the platform minimum of 18.
 * @throws ComplianceBlockedError when the player is under the minimum age.
 */
export function assertMinimumAge(
  dateOfBirth: string,
  now: Date,
  minimumAge: number = AUTH_POLICY.minimumAgeYears,
): void {
  if (ageInYears(dateOfBirth, now) < Math.max(minimumAge, AUTH_POLICY.minimumAgeYears)) {
    throw new ComplianceBlockedError({ message: 'Under minimum age' });
  }
}
