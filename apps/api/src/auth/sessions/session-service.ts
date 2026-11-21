import { AuthError, ErrorCode, ForbiddenError } from '@reef/errors';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { AuditWriter, Queryable } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import { AUTH_POLICY } from '../auth-policy.js';
import { addMs, type Clock } from '../../shared/clock.js';
import { randomToken, sha256Hex } from '../crypto/secrets.js';
import type { AccessTokenService } from '../tokens/access-token-service.js';
import { csrfTokenFor, isValidCsrfToken } from './csrf.js';
import { sessionRepository } from './session-repository.js';

/** Everything a client needs after a login or a refresh. */
export interface IssuedTokens {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly csrfToken: string;
}

/** How a refresh token arrived, which decides whether a CSRF header is required. */
export interface RefreshRequest {
  readonly refreshToken: string;
  readonly ip: string | null;
  /** Set for cookie-borne tokens: the `X-CSRF-Token` header (possibly missing). */
  readonly csrfHeader?: { readonly value: string | undefined };
}

/** Settings and collaborators for {@link SessionService}. */
export interface SessionServiceDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly accessTokens: AccessTokenService;
  readonly audit: AuditWriter;
  readonly hmacKey: Buffer;
  readonly clock: Clock;
  readonly refreshTtlDays: number;
}

const DAY_MS = 86_400_000;
// Revocations must outlive every access token issued before them, plus clock skew.
const REVOCATION_TTL_SECONDS = Math.ceil(AUTH_POLICY.accessTokenTtlMs / 1000) + 60;
const revokedKey = (sessionId: string): string => `auth:v1:revoked-session:${sessionId}`;

type Rotation =
  | {
      readonly kind: 'rotated';
      readonly tokens: Omit<IssuedTokens, 'accessToken' | 'accessTokenExpiresAt'>;
      readonly authTime: Date;
      readonly amr: readonly string[];
    }
  | { readonly kind: 'revoked'; readonly sessionId: string; readonly reason: string };

/**
 * Login sessions and refresh-token families (playbook Step 6). Refresh tokens are opaque
 * 256-bit values stored as SHA-256 hashes and rotated on every use. Presenting a token that was
 * already used is treated as theft: the whole family (session) is revoked.
 */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /**
   * Starts a session after a successful primary login.
   *
   * @param input The user, the methods used (RFC 8176 `amr`), and the client IP.
   * @returns Fresh tokens.
   * @throws AuthError INVALID_CREDENTIALS when the account is closed. Every login method
   *   (password, passkey, MFA completion, signup) starts its session here, so none can bypass it.
   */
  async start(input: {
    userId: string;
    amr: readonly string[];
    ip: string | null;
  }): Promise<IssuedTokens> {
    const now = this.deps.clock.now();
    const expiresAt = addMs(now, this.deps.refreshTtlDays * DAY_MS);
    const refreshToken = randomToken();
    const sessionId = await withTransaction(this.deps.pool, async (client) => {
      if (!(await sessionRepository.isAccountOpen(client, input.userId))) {
        throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
      }
      const id = await sessionRepository.createSession(client, {
        userId: input.userId,
        authTime: now,
        amr: input.amr,
        expiresAt,
      });
      await sessionRepository.insertRefreshToken(client, {
        sessionId: id,
        tokenHash: sha256Hex(refreshToken),
        expiresAt,
      });
      await this.deps.audit.record(
        {
          actorType: 'player',
          actorId: input.userId,
          action: 'auth.session.started',
          targetType: 'auth_session',
          targetId: id,
          details: { amr: input.amr.join(' ') },
          ip: input.ip,
        },
        client,
      );
      return id;
    });
    return this.#issue({
      userId: input.userId,
      sessionId,
      authTime: now,
      amr: input.amr,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
    });
  }

  /**
   * Rotates a refresh token: marks it used and issues a new one in the same family.
   *
   * @param request The token, client IP, and CSRF header for cookie clients.
   * @returns Fresh tokens. `authTime` carries over, so refresh never satisfies step-up.
   * @throws AuthError when the token is unknown, expired, revoked, or reused, or the account
   *   was closed (reuse and closure also revoke the session).
   * @throws ForbiddenError (CSRF_INVALID) when a cookie client sends no valid CSRF header.
   */
  async refresh(request: RefreshRequest): Promise<IssuedTokens> {
    const now = this.deps.clock.now();
    const rotation = await withTransaction(this.deps.pool, async (client): Promise<Rotation> => {
      const record = await sessionRepository.lockRefreshToken(
        client,
        sha256Hex(request.refreshToken),
      );
      if (record === undefined) throw new AuthError({ message: 'Unknown refresh token' });
      if (
        request.csrfHeader !== undefined &&
        !isValidCsrfToken(this.deps.hmacKey, record.sessionId, request.csrfHeader.value)
      ) {
        throw new ForbiddenError({ code: ErrorCode.CSRF_INVALID });
      }
      if (record.sessionRevokedAt !== null) throw new AuthError({ message: 'Session revoked' });
      if (record.usedAt !== null) {
        await this.#revokeInTransaction(client, {
          sessionId: record.sessionId,
          userId: record.userId,
          reason: 'refresh_token_reuse',
          ip: request.ip,
          at: now,
        });
        return { kind: 'revoked', sessionId: record.sessionId, reason: 'Refresh token reused' };
      }
      if (record.isAccountClosed) {
        await this.#revokeInTransaction(client, {
          sessionId: record.sessionId,
          userId: record.userId,
          reason: 'account_closed',
          ip: request.ip,
          at: now,
        });
        return { kind: 'revoked', sessionId: record.sessionId, reason: 'Account closed' };
      }
      if (record.expiresAt <= now || record.sessionExpiresAt <= now) {
        throw new AuthError({ message: 'Refresh token expired' });
      }

      const refreshToken = randomToken();
      await sessionRepository.markRefreshTokenUsed(client, record.tokenId, now);
      await sessionRepository.insertRefreshToken(client, {
        sessionId: record.sessionId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: record.sessionExpiresAt,
      });
      await this.deps.audit.record(
        {
          actorType: 'player',
          actorId: record.userId,
          action: 'auth.refresh.rotated',
          targetType: 'auth_session',
          targetId: record.sessionId,
          ip: request.ip,
        },
        client,
      );
      return {
        kind: 'rotated',
        authTime: record.authTime,
        amr: record.amr,
        tokens: {
          userId: record.userId,
          sessionId: record.sessionId,
          refreshToken,
          refreshTokenExpiresAt: record.sessionExpiresAt,
          csrfToken: csrfTokenFor(this.deps.hmacKey, record.sessionId),
        },
      };
    });

    if (rotation.kind === 'revoked') {
      // The revocation committed above; now cut off access tokens already in flight.
      await this.#cacheRevocations([rotation.sessionId]);
      throw new AuthError({ message: `${rotation.reason}; session revoked` });
    }
    return this.#issue({ ...rotation.tokens, authTime: rotation.authTime, amr: rotation.amr });
  }

  /**
   * Ends a session (logout). Idempotent.
   *
   * @param input Session, acting user, reason, and client IP.
   */
  async revoke(input: {
    sessionId: string;
    userId: string;
    reason: string;
    ip: string | null;
  }): Promise<void> {
    const at = this.deps.clock.now();
    await withTransaction(this.deps.pool, (client) =>
      this.#revokeInTransaction(client, { ...input, at }),
    );
    await this.#cacheRevocations([input.sessionId]);
  }

  /**
   * Logout with a refresh token, which works even after the access token expired. Unknown
   * tokens are ignored, so logout is idempotent.
   *
   * @param request The token, client IP, and CSRF header for cookie clients.
   * @throws ForbiddenError (CSRF_INVALID) when a cookie client sends no valid CSRF header.
   */
  async endByRefreshToken(request: RefreshRequest): Promise<void> {
    const found = await sessionRepository.findSessionByRefreshToken(
      this.deps.pool,
      sha256Hex(request.refreshToken),
    );
    if (found === undefined) return;
    if (
      request.csrfHeader !== undefined &&
      !isValidCsrfToken(this.deps.hmacKey, found.sessionId, request.csrfHeader.value)
    ) {
      throw new ForbiddenError({ code: ErrorCode.CSRF_INVALID });
    }
    await this.revoke({ ...found, reason: 'logout', ip: request.ip });
  }

  /**
   * Revokes every other session of a user, for example after a contact change or 2FA reset.
   *
   * @param input User, the session to keep, reason, and client IP.
   */
  async revokeOthers(input: {
    userId: string;
    keepSessionId: string;
    reason: string;
    ip: string | null;
  }): Promise<void> {
    const at = this.deps.clock.now();
    const revoked = await withTransaction(this.deps.pool, async (client) => {
      const ids = await sessionRepository.revokeUserSessions(client, {
        userId: input.userId,
        reason: input.reason,
        at,
        exceptSessionId: input.keepSessionId,
      });
      if (ids.length > 0) {
        await this.deps.audit.record(
          {
            actorType: 'player',
            actorId: input.userId,
            action: 'auth.session.revoked_others',
            targetType: 'user',
            targetId: input.userId,
            details: { reason: input.reason, count: ids.length },
            ip: input.ip,
          },
          client,
        );
      }
      return ids;
    });
    await this.#cacheRevocations(revoked);
  }

  /**
   * @param sessionId Session from a verified access token.
   * @returns True when the session was revoked recently enough that its access tokens may
   *   still be unexpired.
   */
  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.deps.redis.exists(revokedKey(sessionId))) === 1;
  }

  async #revokeInTransaction(
    client: Queryable,
    input: { sessionId: string; userId: string; reason: string; ip: string | null; at: Date },
  ): Promise<void> {
    const didRevoke = await sessionRepository.revokeSession(client, input);
    if (!didRevoke) return;
    await this.deps.audit.record(
      {
        actorType: 'player',
        actorId: input.userId,
        action:
          input.reason === 'refresh_token_reuse'
            ? 'auth.refresh.reuse_detected'
            : 'auth.session.revoked',
        targetType: 'auth_session',
        targetId: input.sessionId,
        details: { reason: input.reason },
        ip: input.ip,
      },
      client,
    );
  }

  async #cacheRevocations(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const pipeline = this.deps.redis.multi();
    for (const id of sessionIds) pipeline.set(revokedKey(id), '1', 'EX', REVOCATION_TTL_SECONDS);
    const results = (await pipeline.exec()) ?? [];
    const failure = results.find(([error]) => error !== null);
    if (failure !== undefined) throw failure[0] ?? new Error('Redis MULTI failed');
  }

  async #issue(input: {
    userId: string;
    sessionId: string;
    authTime: Date;
    amr: readonly string[];
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  }): Promise<IssuedTokens> {
    const access = await this.deps.accessTokens.sign({
      userId: input.userId,
      sessionId: input.sessionId,
      authTime: input.authTime,
      amr: input.amr,
    });
    return {
      userId: input.userId,
      sessionId: input.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: input.refreshToken,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      csrfToken: csrfTokenFor(this.deps.hmacKey, input.sessionId),
    };
  }
}
