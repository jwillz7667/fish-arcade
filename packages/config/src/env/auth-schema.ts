import { z } from 'zod';

import { corsOriginsSchema } from './cors-origins.js';

// Cloudflare's documented Turnstile test secrets: always pass, always fail, or token spent.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TURNSTILE_TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

/**
 * @param secret A Turnstile secret key.
 * @returns True for one of Cloudflare's test secrets, whose replies carry no real action or
 *   hostname. They are rejected in production.
 */
export function isTurnstileTestSecret(secret: string): boolean {
  return TURNSTILE_TEST_SECRETS.has(secret);
}

const booleanFlag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

/**
 * Player auth settings (playbook Step 6, spec §5.1). Each key is set inline from Secrets
 * Manager in production, or as a file under `.keys/dev/` in development; startup checks that
 * exactly one source is set.
 */
export const AUTH_SHAPE = {
  // Ed25519 PKCS#8 PEM that signs access tokens, and its `kid` header for rotation.
  AUTH_JWT_PRIVATE_KEY: z.string().min(1).optional(),
  AUTH_JWT_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  AUTH_JWT_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  // 32-byte base64 HMAC key for OTP codes, recovery codes, and CSRF tokens.
  AUTH_HMAC_KEY: z.string().min(1).optional(),
  AUTH_HMAC_KEY_FILE: z.string().min(1).optional(),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  WEBAUTHN_RP_ID: z.string().regex(/^[a-z0-9.-]{1,253}$/),
  WEBAUTHN_RP_NAME: z.string().min(1).max(64).default('Reef'),
  WEBAUTHN_ORIGINS: corsOriginsSchema,
  HIBP_ENABLED: booleanFlag,
  TURNSTILE_SECRET_KEY: z.string().min(1),
  EMAIL_PROVIDER: z.enum(['mailpit']),
  SMS_PROVIDER: z.enum(['mailpit']),
  MAILPIT_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8025'),
  EMAIL_FROM: z.email().default('no-reply@reef.local'),
};

/**
 * Values that must never reach production. Mailpit is the only email and SMS provider so far,
 * so production fails closed at startup until a vendor adapter is added.
 */
export const AUTH_DEV_ONLY_RULES = {
  AUTH_JWT_PRIVATE_KEY_FILE: (value: unknown) => value !== undefined,
  AUTH_HMAC_KEY_FILE: (value: unknown) => value !== undefined,
  TURNSTILE_SECRET_KEY: (value: unknown) =>
    typeof value === 'string' && TURNSTILE_TEST_SECRETS.has(value),
  EMAIL_PROVIDER: (value: unknown) => value === 'mailpit',
  SMS_PROVIDER: (value: unknown) => value === 'mailpit',
  WEBAUTHN_ORIGINS: (value: unknown) =>
    Array.isArray(value) && value.some((origin) => String(origin).startsWith('http:')),
  // Turning the breached-password check off is for offline development only.
  HIBP_ENABLED: (value: unknown) => value === false,
};
