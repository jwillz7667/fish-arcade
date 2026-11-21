import { createHash } from 'node:crypto';

import { DependencyUnavailableError } from '@reef/errors';

/** Reports whether a password appears in a known breach corpus. */
export interface BreachedPasswordChecker {
  /**
   * @param password Candidate password.
   * @returns True when it has been seen in a breach.
   * @throws DependencyUnavailableError when the check cannot be completed.
   */
  isBreached(password: string): Promise<boolean>;
}

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3_000;
const LINE = /^([0-9A-F]{35}):(\d+)$/;

/**
 * Have I Been Pwned "Pwned Passwords" range API (k-anonymity): only the first 5 hex characters
 * of the SHA-1 leave the server, and `Add-Padding` hides the true size of the response. Fails
 * closed: if HIBP is down, signup and password changes wait rather than accept an unchecked
 * password.
 */
export class HibpBreachedPasswordChecker implements BreachedPasswordChecker {
  /** @param fetchFn Injected for tests; defaults to global fetch. */
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /**
   * @param password Candidate password.
   * @returns True when HIBP reports at least one breach occurrence.
   * @throws DependencyUnavailableError when HIBP is unreachable or answers with an error.
   */
  async isBreached(password: string): Promise<boolean> {
    // SHA-1 is what the HIBP API is keyed on; it is not used to store anything.
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    let body: string;
    try {
      const response = await this.fetchFn(`${RANGE_URL}${prefix}`, {
        headers: { 'add-padding': 'true', 'user-agent': 'reef-api' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HIBP returned ${String(response.status)}`);
      body = await response.text();
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'hibp',
        message: 'Breached-password check failed',
        cause: error,
      });
    }
    for (const line of body.split(/\r?\n/)) {
      const match = LINE.exec(line.trim());
      // Padding rows carry a count of 0 and never match a real password.
      if (match?.[1] === suffix && match[2] !== '0') return true;
    }
    return false;
  }
}

/** Used when HIBP_ENABLED=false (offline development). Accepts every password. */
export class DisabledBreachedPasswordChecker implements BreachedPasswordChecker {
  /** @returns Always false. */
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
