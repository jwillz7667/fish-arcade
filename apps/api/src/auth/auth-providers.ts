import type { Provider, Type } from '@nestjs/common';
import type { ApiEnv } from '@reef/config';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { AUTH_KEYS, CLOCK } from '../app/tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import type { JurisdictionService } from '../compliance/jurisdictions/jurisdiction-service.js';
import type { AuthDependencies } from './auth-dependencies.js';
import { AUTH_POLICY } from './auth-policy.js';
import { ContactChangeService } from './contact/contact-change-service.js';
import { AccountSecurityController } from './http/account-security.controller.js';
import { LoginController } from './http/login.controller.js';
import { SessionController } from './http/session.controller.js';
import { SignupController } from './http/signup.controller.js';
import { BackoffThrottle } from './login/backoff-throttle.js';
import { LoginService, mfaTicketSchema } from './login/login-service.js';
import { MfaService } from './mfa/mfa-service.js';
import { OtpService } from './otp/otp-service.js';
import { PasskeyService } from './passkeys/passkey-service.js';
import { PasswordHasher } from './password/password-hasher.js';
import { SessionService } from './sessions/session-service.js';
import { signupTicketSchema, SignupService } from './signup/signup-service.js';
import { StepUpGuard } from './step-up/step-up.guard.js';
import { TicketStore } from './tickets/ticket-store.js';
import { AccessTokenService } from './tokens/access-token-service.js';

/** Controllers for player auth. */
export const AUTH_CONTROLLERS: readonly Type[] = [
  SignupController,
  LoginController,
  SessionController,
  AccountSecurityController,
];

/**
 * Wires player auth from explicit dependencies. Services are plain classes constructed here,
 * not by Nest, so they stay framework-free; Nest only receives the finished instances.
 *
 * @param input Env, pool, Redis, auth dependencies, the shared audit writer, and the
 *   jurisdiction service (signup checks the declared home state).
 * @returns Providers for the root module.
 */
export function createAuthProviders(input: {
  env: ApiEnv;
  pool: Pool;
  redis: Redis;
  auth: AuthDependencies;
  audit: AuditWriter;
  jurisdictions: JurisdictionService;
}): Provider[] {
  const { env, pool, redis, auth, audit, jurisdictions } = input;
  const { clock, keys, encryption } = auth;
  const accessTokens = new AccessTokenService(keys, clock);
  const hasher = new PasswordHasher();
  const throttle = new BackoffThrottle(redis);
  const sessions = new SessionService({
    pool,
    redis,
    accessTokens,
    audit,
    hmacKey: keys.hmacKey,
    clock,
    refreshTtlDays: env.AUTH_REFRESH_TTL_DAYS,
  });
  const otp = new OtpService({
    pool,
    cipher: encryption.cipher,
    hmacKey: keys.hmacKey,
    senders: auth.senders,
    clock,
  });
  const mfa = new MfaService({
    pool,
    cipher: encryption.cipher,
    hmacKey: keys.hmacKey,
    audit,
    clock,
  });
  const passkeys = new PasskeyService({
    pool,
    redis,
    audit,
    clock,
    config: {
      rpId: env.WEBAUTHN_RP_ID,
      rpName: env.WEBAUTHN_RP_NAME,
      origins: env.WEBAUTHN_ORIGINS,
    },
  });
  const signup = new SignupService({
    pool,
    jurisdictions,
    encryption,
    otp,
    sessions,
    passkeys,
    hasher,
    breachChecker: auth.breachChecker,
    botVerifier: auth.botVerifier,
    tickets: new TicketStore(
      redis,
      'signup-ticket',
      signupTicketSchema,
      AUTH_POLICY.signupTicketTtlSeconds,
    ),
    audit,
    clock,
  });
  const login = new LoginService({
    pool,
    blindIndexer: encryption.blindIndexer,
    hasher,
    throttle,
    mfa,
    passkeys,
    sessions,
    mfaTickets: new TicketStore(
      redis,
      'mfa-ticket',
      mfaTicketSchema,
      AUTH_POLICY.mfaTicket.ttlSeconds,
    ),
    audit,
  });
  const contact = new ContactChangeService({ pool, encryption, otp, sessions, audit });

  return [
    { provide: AUTH_KEYS, useValue: keys },
    { provide: CLOCK, useValue: clock },
    { provide: AccessTokenService, useValue: accessTokens },
    { provide: BackoffThrottle, useValue: throttle },
    { provide: SessionService, useValue: sessions },
    { provide: OtpService, useValue: otp },
    { provide: MfaService, useValue: mfa },
    { provide: PasskeyService, useValue: passkeys },
    { provide: SignupService, useValue: signup },
    { provide: LoginService, useValue: login },
    { provide: ContactChangeService, useValue: contact },
    StepUpGuard,
  ];
}
