import { randomUUID } from 'node:crypto';

import { DependencyUnavailableError, ErrorCode, ForbiddenError } from '@reef/errors';
import { z } from 'zod';

/** Server-side bot check for signup. */
export interface BotVerifier {
  /**
   * @param token Token the client widget produced.
   * @param ip Client IP, passed to the provider as a signal.
   * @throws ForbiddenError (BOT_CHECK_FAILED) when the token is invalid, spent, or expired.
   * @throws DependencyUnavailableError when the provider cannot be reached.
   */
  verify(token: string, ip: string | null): Promise<void>;
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;
const EXPECTED_ACTION = 'signup';

const responseSchema = z.object({
  success: z.boolean(),
  action: z.string().optional(),
  hostname: z.string().optional(),
  'error-codes': z.array(z.string()).default([]),
});

/** Where the widget may run, and whether the secret is a Cloudflare test secret. */
export interface TurnstileOptions {
  /** Hostnames of the player web app. A token solved on any other site is refused. */
  readonly expectedHostnames: readonly string[];
  /** Test secrets reply without an action or a real hostname, so those checks are skipped. */
  readonly isTestSecret: boolean;
}

/**
 * Cloudflare Turnstile siteverify (playbook Step 6). Tokens are single-use and expire after
 * 300 seconds; Cloudflare enforces both. The reply must name the signup action and one of our
 * hostnames, so a token solved for another action or on another site is refused. Fails closed
 * when Cloudflare is unreachable.
 */
export class TurnstileVerifier implements BotVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly options: TurnstileOptions,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * @param token Widget token from the signup form.
   * @param ip Client IP.
   * @throws ForbiddenError (BOT_CHECK_FAILED) when Cloudflare rejects the token, or it was
   *   issued for another action or on another hostname.
   * @throws DependencyUnavailableError when Cloudflare is unreachable or answers oddly.
   */
  async verify(token: string, ip: string | null): Promise<void> {
    const form = new URLSearchParams({
      secret: this.secretKey,
      response: token,
      // Lets a retry after a network error re-check the same token instead of failing it.
      idempotency_key: randomUUID(),
    });
    if (ip !== null) form.set('remoteip', ip);

    let parsed: z.infer<typeof responseSchema>;
    try {
      const response = await this.fetchFn(SITEVERIFY_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`siteverify returned ${String(response.status)}`);
      parsed = responseSchema.parse(await response.json());
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'turnstile',
        message: 'Turnstile verification failed',
        cause: error,
      });
    }
    if (!parsed.success) {
      throw new ForbiddenError({
        code: ErrorCode.BOT_CHECK_FAILED,
        message: `Turnstile rejected the token: ${parsed['error-codes'].join(',')}`,
      });
    }
    if (this.options.isTestSecret) return;
    if (parsed.action !== EXPECTED_ACTION) {
      throw new ForbiddenError({
        code: ErrorCode.BOT_CHECK_FAILED,
        message: 'Turnstile token was issued for another action',
      });
    }
    if (
      parsed.hostname === undefined ||
      !this.options.expectedHostnames.includes(parsed.hostname)
    ) {
      throw new ForbiddenError({
        code: ErrorCode.BOT_CHECK_FAILED,
        message: 'Turnstile token was solved on another hostname',
      });
    }
  }
}
