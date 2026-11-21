import type { Provider, Type } from '@nestjs/common';
import type { ApiEnv } from '@reef/config';
import type { FieldEncryption } from '@reef/crypto-fields';
import { ConfigError } from '@reef/errors';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { AuditWriter } from '../audit/audit-writer.js';
import { BackoffThrottle } from '../auth/login/backoff-throttle.js';
import type { Clock } from '../shared/clock.js';
import { ADMIN_IP_ALLOWLIST, ADMIN_WEB_ORIGIN } from './admin-tokens.js';
import { AdminRolesController } from './admins/admin-roles.controller.js';
import { AdminRolesService } from './admins/admin-roles-service.js';
import { APPROVAL_ACTIONS } from './approvals/approval-actions.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import { ApprovalsService } from './approvals/approvals-service.js';
import { AdminAuditController } from './audit/admin-audit.controller.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import { AdminLoginService } from './auth/admin-login-service.js';
import { AdminMfaService } from './auth/admin-mfa-service.js';
import { AdminSessionService } from './auth/admin-session-service.js';
import { OidcClient } from './auth/oidc-client.js';
import { AdminAuditInterceptor } from './http/admin-audit.interceptor.js';
import { AdminGuard, buildAllowlist } from './http/admin.guard.js';
import { AdminJurisdictionsController } from './jurisdictions/admin-jurisdictions.controller.js';
import { AdminPlayerService } from './players/admin-player-service.js';
import { AdminPlayersController } from './players/admin-players.controller.js';

/** Back office controllers, all under `/v1/admin`. */
export const ADMIN_CONTROLLERS: readonly Type[] = [
  AdminAuthController,
  AdminPlayersController,
  AdminJurisdictionsController,
  ApprovalsController,
  AdminRolesController,
  AdminAuditController,
];

function oidcClientFor(env: ApiEnv, fetchFn: typeof fetch | undefined): OidcClient | undefined {
  if (env.ADMIN_LOGIN_MODE !== 'oidc') return undefined;
  const missing = (
    [
      ['ADMIN_OIDC_ISSUER', env.ADMIN_OIDC_ISSUER],
      ['ADMIN_OIDC_CLIENT_ID', env.ADMIN_OIDC_CLIENT_ID],
      ['ADMIN_OIDC_CLIENT_SECRET', env.ADMIN_OIDC_CLIENT_SECRET],
      ['ADMIN_OIDC_REDIRECT_URI', env.ADMIN_OIDC_REDIRECT_URI],
    ] as const
  ).filter(([, value]) => value === undefined);
  if (
    missing.length > 0 ||
    env.ADMIN_OIDC_ISSUER === undefined ||
    env.ADMIN_OIDC_CLIENT_ID === undefined ||
    env.ADMIN_OIDC_CLIENT_SECRET === undefined ||
    env.ADMIN_OIDC_REDIRECT_URI === undefined
  ) {
    throw new ConfigError({
      issues: missing.map(([path]) => ({ path, message: 'required when ADMIN_LOGIN_MODE=oidc' })),
    });
  }
  return new OidcClient(
    {
      issuer: env.ADMIN_OIDC_ISSUER,
      clientId: env.ADMIN_OIDC_CLIENT_ID,
      clientSecret: env.ADMIN_OIDC_CLIENT_SECRET,
      redirectUri: env.ADMIN_OIDC_REDIRECT_URI,
    },
    fetchFn,
  );
}

/**
 * Wires the back office (playbook Step 9) from explicit dependencies.
 *
 * @param input Env, pool, Redis, audit writer, clock, HMAC key, field encryption, and an
 *   optional fetch for the OIDC client (tests point it at a fake IdP).
 * @returns Providers for the root module.
 * @throws ConfigError when OIDC login is configured without its settings.
 */
export function createAdminProviders(input: {
  env: ApiEnv;
  pool: Pool;
  redis: Redis;
  audit: AuditWriter;
  clock: Clock;
  hmacKey: Buffer;
  encryption: FieldEncryption;
  oidcFetch?: typeof fetch;
}): Provider[] {
  const { env, pool, redis, audit, clock } = input;
  const sessions = new AdminSessionService({
    pool,
    audit,
    hmacKey: input.hmacKey,
    clock,
    idleMinutes: env.ADMIN_SESSION_IDLE_MINUTES,
    maxHours: env.ADMIN_SESSION_MAX_HOURS,
  });
  const mfa = new AdminMfaService({ pool, cipher: input.encryption.cipher, clock });
  const login = new AdminLoginService({
    pool,
    redis,
    audit,
    mfa,
    sessions,
    throttle: new BackoffThrottle(redis),
    mode: env.ADMIN_LOGIN_MODE,
    oidc: oidcClientFor(env, input.oidcFetch),
    allowedEmailDomains: env.ADMIN_ALLOWED_EMAIL_DOMAINS,
  });
  return [
    { provide: ADMIN_IP_ALLOWLIST, useValue: buildAllowlist(env.ADMIN_IP_ALLOWLIST) },
    { provide: ADMIN_WEB_ORIGIN, useValue: env.ADMIN_WEB_ORIGIN },
    { provide: AdminSessionService, useValue: sessions },
    { provide: AdminLoginService, useValue: login },
    {
      provide: ApprovalsService,
      useValue: new ApprovalsService({ pool, audit, clock, actions: APPROVAL_ACTIONS }),
    },
    { provide: AdminRolesService, useValue: new AdminRolesService({ pool, audit }) },
    {
      provide: AdminPlayerService,
      useValue: new AdminPlayerService({ pool, encryption: input.encryption }),
    },
    AdminGuard,
    AdminAuditInterceptor,
  ];
}
