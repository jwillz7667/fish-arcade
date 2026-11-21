import { ValidationError } from '@reef/errors';
import { z } from 'zod';

import { AUTH_POLICY } from '../auth-policy.js';
import type { BreachedPasswordChecker } from './breached-password-checker.js';

/**
 * Request-body schema for a new password: 12 to 128 characters, no composition rules
 * (NIST SP 800-63B). The upper bound caps hashing cost per request.
 */
export const newPasswordSchema = z
  .string()
  .min(AUTH_POLICY.password.minLength)
  .max(AUTH_POLICY.password.maxLength);

/**
 * Rejects passwords found in a breach corpus.
 *
 * @param password A password that already passed {@link newPasswordSchema}.
 * @param checker HIBP, or the disabled checker when the toggle is off.
 * @throws ValidationError on `password` when it has been breached.
 * @throws DependencyUnavailableError when the check cannot run.
 */
export async function assertPasswordNotBreached(
  password: string,
  checker: BreachedPasswordChecker,
): Promise<void> {
  if (await checker.isBreached(password)) {
    throw new ValidationError({
      issues: [
        {
          path: 'password',
          message: 'This password has appeared in a data breach. Choose a different one.',
        },
      ],
    });
  }
}
