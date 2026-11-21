import { isIP } from 'node:net';

import { z } from 'zod';

const cidrSchema = z.string().refine((value) => {
  const [address = '', bits, ...rest] = value.split('/');
  const family = isIP(address);
  if (family === 0 || bits === undefined || rest.length > 0 || !/^\d{1,3}$/.test(bits))
    return false;
  return Number.parseInt(bits, 10) <= (family === 4 ? 32 : 128);
}, 'must be a CIDR block like 10.0.0.0/8');

/** Comma-separated CIDR blocks, such as the office and VPN ranges for the back office. */
export const cidrListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(cidrSchema).min(1));

/**
 * Back office auth (playbook Step 9, spec §13.3). OIDC settings are required when
 * ADMIN_LOGIN_MODE is `oidc`; startup checks that, since it spans several variables.
 */
export const ADMIN_SHAPE = {
  ADMIN_LOGIN_MODE: z.enum(['oidc', 'dev_local']),
  ADMIN_OIDC_ISSUER: z.url({ protocol: /^https?$/ }).optional(),
  ADMIN_OIDC_CLIENT_ID: z.string().min(1).optional(),
  ADMIN_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  ADMIN_OIDC_REDIRECT_URI: z.url({ protocol: /^https?$/ }).optional(),
  // Only staff from these domains may sign in, even with a valid IdP account.
  ADMIN_ALLOWED_EMAIL_DOMAINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    )
    .pipe(z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1)),
  // Where the back office web app lives; the OIDC callback redirects there.
  ADMIN_WEB_ORIGIN: z.url({ protocol: /^https?$/ }),
  ADMIN_IP_ALLOWLIST: cidrListSchema.default(['127.0.0.1/32', '::1/128']),
  // Spec §13.3: 30-minute idle timeout.
  ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(30).default(30),
  ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),
};

const isHttp = (value: unknown): boolean => typeof value === 'string' && value.startsWith('http:');

/** Values that must never reach production. */
export const ADMIN_DEV_ONLY_RULES = {
  ADMIN_LOGIN_MODE: (value: unknown) => value === 'dev_local',
  ADMIN_OIDC_ISSUER: isHttp,
  ADMIN_OIDC_REDIRECT_URI: isHttp,
  ADMIN_WEB_ORIGIN: isHttp,
  // An allowlist that allows everyone is no allowlist.
  ADMIN_IP_ALLOWLIST: (value: unknown) =>
    Array.isArray(value) && value.some((cidr) => cidr === '0.0.0.0/0' || cidr === '::/0'),
};
