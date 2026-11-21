import { AuthError, ErrorCode, ForbiddenError, isDomainError } from '@reef/errors';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { safeEqual } from '../../auth/crypto/secrets.js';
import type { BackoffThrottle } from '../../auth/login/backoff-throttle.js';
import { TicketStore } from '../../auth/tickets/ticket-store.js';
import { ACCOUNT_BACKOFF } from '../../auth/auth-policy.js';
import type { AdminMfaService } from './admin-mfa-service.js';
import type { AdminSessionService, IssuedAdminSession } from './admin-session-service.js';
import type { OidcClient, OidcPending } from './oidc-client.js';

/** How admins prove who they are before MFA. `dev_local` is rejected in production. */
export type AdminLoginMode = 'oidc' | 'dev_local';

/** What the client must do after primary login. */
export type AdminMfaStep = 'mfa_enrollment_required' | 'mfa_required';

const MFA_TICKET_TTL_SECONDS = 5 * 60;
const MFA_TICKET_MAX_ATTEMPTS = 5;
const OIDC_PENDING_TTL_SECONDS = 10 * 60;

const mfaTicketSchema = z.object({ adminId: z.uuid() });
const pendingSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
});

/** Collaborators for {@link AdminLoginService}. */
export interface AdminLoginServiceDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly audit: AuditWriter;
  readonly mfa: AdminMfaService;
  readonly sessions: AdminSessionService;
  readonly throttle: BackoffThrottle;
  readonly mode: AdminLoginMode;
  readonly oidc: OidcClient | undefined;
  readonly allowedEmailDomains: readonly string[];
}

/**
 * Back office login (playbook Step 9). Primary login is OIDC SSO, or a seeded local login in
 * development. MFA is mandatory: the first login enrols TOTP before any session exists. Admins
 * are never created by logging in; only an existing, active admin with an allowed email domain
 * gets through.
 */
export class AdminLoginService {
  readonly #mfaTickets: TicketStore<z.infer<typeof mfaTicketSchema>>;
  readonly #oidcPending: TicketStore<OidcPending>;

  constructor(private readonly deps: AdminLoginServiceDeps) {
    this.#mfaTickets = new TicketStore(
      deps.redis,
      'admin-mfa-ticket',
      mfaTicketSchema,
      MFA_TICKET_TTL_SECONDS,
    );
    this.#oidcPending = new TicketStore(
      deps.redis,
      'admin-oidc',
      pendingSchema,
      OIDC_PENDING_TTL_SECONDS,
    );
  }

  /**
   * Development login for seeded admins.
   *
   * @param input Email and IP.
   * @returns The MFA ticket and which MFA step comes next.
   * @throws ForbiddenError when local login is not enabled.
   * @throws AuthError INVALID_CREDENTIALS for unknown or disabled admins.
   */
  async devLogin(input: {
    email: string;
    ip: string;
  }): Promise<{ mfaTicket: string; next: AdminMfaStep }> {
    if (this.deps.mode !== 'dev_local')
      throw new ForbiddenError({ message: 'Local admin login disabled' });
    return this.#afterPrimaryLogin(input.email, input.ip, 'dev_local');
  }

  /**
   * @returns Where to send the browser, and a handle the callback must present (as a cookie).
   * @throws ForbiddenError when OIDC is not the login mode.
   */
  async startOidc(): Promise<{ authorizationUrl: string; handle: string }> {
    const oidc = this.#requireOidc();
    const { authorizationUrl, pending } = await oidc.start();
    return { authorizationUrl, handle: await this.#oidcPending.issue(pending) };
  }

  /**
   * @param input Code and state from the IdP redirect, the handle cookie, and the IP.
   * @returns The MFA ticket and which MFA step comes next.
   * @throws AuthError when the state does not match, the login expired, or the IdP's answer is
   *   invalid, or the admin is unknown.
   */
  async finishOidc(input: {
    code: string;
    state: string;
    handle: string | undefined;
    ip: string;
  }): Promise<{ mfaTicket: string; next: AdminMfaStep }> {
    const oidc = this.#requireOidc();
    const pending =
      input.handle === undefined ? undefined : await this.#oidcPending.take(input.handle);
    if (pending === undefined || !safeEqual(input.state, pending.state)) {
      throw new AuthError({ message: 'OIDC state mismatch or expired login' });
    }
    const email = await oidc.finish(input.code, pending);
    return this.#afterPrimaryLogin(email, input.ip, 'oidc');
  }

  /**
   * Starts TOTP enrolment for an admin who has none, using their MFA ticket.
   *
   * @param mfaTicket Ticket from primary login.
   * @returns The secret and `otpauth://` URI.
   * @throws AuthError when the ticket is unknown or expired.
   */
  async beginMfaSetup(mfaTicket: string): Promise<{ secret: string; otpauthUri: string }> {
    const { adminId } = await this.#ticket(mfaTicket);
    return this.deps.mfa.beginSetup(adminId);
  }

  /**
   * Finishes primary login plus MFA: confirms enrolment (first login) or checks a code.
   *
   * @param input Ticket, code, and IP.
   * @returns A new admin session.
   * @throws AuthError OTP_INVALID or OTP_EXPIRED, or OTP_ATTEMPTS_EXCEEDED after 5 wrong codes.
   * @throws RateLimitedError while the admin is backing off.
   */
  async completeMfa(input: {
    mfaTicket: string;
    code: string;
    ip: string;
  }): Promise<IssuedAdminSession> {
    const { adminId } = await this.#ticket(input.mfaTicket);
    const subject = { key: `admin2fa:${adminId}`, policy: ACCOUNT_BACKOFF };
    await this.deps.throttle.assertAllowed([subject]);
    if ((await this.#mfaTickets.countAttempt(input.mfaTicket)) > MFA_TICKET_MAX_ATTEMPTS) {
      await this.#mfaTickets.revoke(input.mfaTicket);
      throw new AuthError({ code: ErrorCode.OTP_ATTEMPTS_EXCEEDED });
    }
    try {
      if (await this.deps.mfa.isEnrolled(adminId)) await this.deps.mfa.verify(adminId, input.code);
      else await this.deps.mfa.confirmSetup(adminId, input.code);
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.OTP_INVALID) {
        await this.deps.throttle.recordFailure([subject]);
        await this.#audit('admin.login.mfa_failed', adminId, input.ip);
      }
      throw error;
    }
    if ((await this.#mfaTickets.take(input.mfaTicket)) === undefined) {
      throw new AuthError({ message: 'Admin MFA ticket already used' });
    }
    await this.deps.throttle.reset(subject);
    await this.#audit('admin.login.succeeded', adminId, input.ip);
    return this.deps.sessions.create({ adminId, ip: input.ip });
  }

  async #afterPrimaryLogin(
    email: string,
    ip: string,
    method: AdminLoginMode,
  ): Promise<{ mfaTicket: string; next: AdminMfaStep }> {
    const normalized = email.trim().toLowerCase();
    const domain = normalized.split('@')[1] ?? '';
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE email = $1 AND status = 'active'`,
      [normalized],
    );
    const adminId = rows[0]?.id;
    if (adminId === undefined || !this.deps.allowedEmailDomains.includes(domain)) {
      await this.deps.audit.record({
        actorType: 'admin',
        actorId: null,
        action: 'admin.login.denied',
        details: { method },
        ip,
      });
      throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    }
    await this.#audit('admin.login.primary_passed', adminId, ip, method);
    const next = (await this.deps.mfa.isEnrolled(adminId))
      ? 'mfa_required'
      : 'mfa_enrollment_required';
    return { mfaTicket: await this.#mfaTickets.issue({ adminId }), next };
  }

  async #ticket(mfaTicket: string): Promise<{ adminId: string }> {
    const ticket = await this.#mfaTickets.peek(mfaTicket);
    if (ticket === undefined)
      throw new AuthError({ message: 'Unknown or expired admin MFA ticket' });
    return ticket;
  }

  #requireOidc(): OidcClient {
    if (this.deps.mode !== 'oidc' || this.deps.oidc === undefined) {
      throw new ForbiddenError({ message: 'OIDC admin login disabled' });
    }
    return this.deps.oidc;
  }

  async #audit(
    action: string,
    adminId: string,
    ip: string,
    method?: AdminLoginMode,
  ): Promise<void> {
    await this.deps.audit.record({
      actorType: 'admin',
      actorId: adminId,
      action,
      targetType: 'admin_user',
      targetId: adminId,
      ...(method === undefined ? {} : { details: { method } }),
      ip,
    });
  }
}
