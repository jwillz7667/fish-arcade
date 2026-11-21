import { createHash } from 'node:crypto';

import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthError, isDomainError, ValidationError } from '@reef/errors';
import type { Logger } from '@reef/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, lastValueFrom, type Observable } from 'rxjs';

import { LOGGER } from '../../app/tokens.js';
import { principalOf } from '../principal.js';
import { canonicalJson } from './canonical-json.js';
import {
  IdempotencyStore,
  PENDING_LEASE_SECONDS,
  type IdempotencyClaim,
  type IdempotencyClaims,
} from './idempotency-store.js';
import { MONEY_ROUTE } from './money-route.decorator.js';

const KEY_PATTERN = /^[A-Za-z0-9_:-]{8,128}$/;
const RENEW_INTERVAL_MS = (PENDING_LEASE_SECONDS * 1000) / 3;

function requestHash(request: FastifyRequest): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.url}\n${canonicalJson(request.body ?? null)}`, 'utf8')
    .digest('hex');
}

/** Player and admin keys live in separate namespaces. */
function actorOf(request: FastifyRequest): string | undefined {
  const principal = principalOf(request);
  if (principal !== undefined) return `player:${principal.userId}`;
  if (request.admin !== undefined) return `admin:${request.admin.adminId}`;
  return undefined;
}

/**
 * A 4xx domain error is raised before anything is committed (validation, insufficient funds, a
 * compliance block), so the key can be released for an immediate retry. Anything else may have
 * happened after money moved; the claim then lapses on its own, and a retry after that is safe
 * only because the handler's ledger key derives from the same Idempotency-Key.
 */
function isSafeToRelease(error: unknown): boolean {
  return isDomainError(error) && error.httpStatus < 500;
}

/**
 * Enforces idempotency on routes marked `@MoneyRoute()` (playbook Step 5). The first request
 * claims the key under a lease it renews while the handler runs; duplicates get 409 meanwhile;
 * later retries replay the stored response. Handlers read the scoped key with
 * `moneyRouteKeyOf` and pass it (or a derivative) to `postJournal`, so even a second run of the
 * handler cannot move money twice.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdempotencyStore) private readonly store: IdempotencyClaims,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * @param context Current request.
   * @param next The route handler.
   * @returns The handler's response, or the stored response on a retry.
   * @throws ValidationError when the Idempotency-Key header is missing or malformed.
   * @throws AuthError when the caller is not authenticated.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isMoneyRoute = this.reflector.get<boolean | undefined>(MONEY_ROUTE, context.getHandler());
    if (isMoneyRoute !== true) return next.handle();
    return from(this.#run(context, next));
  }

  async #run(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new ValidationError({
        issues: [
          { path: 'Idempotency-Key', message: 'Required header: 8 to 128 of A-Z a-z 0-9 _ : -' },
        ],
      });
    }
    const actor = actorOf(request);
    if (actor === undefined) throw new AuthError();

    const scope = `${actor}:${key}`;
    const decision = await this.store.begin(scope, requestHash(request));
    if (decision.kind === 'replay') {
      void http.getResponse<FastifyReply>().header('idempotent-replayed', 'true');
      return decision.body;
    }
    request.moneyRouteKey = scope;
    const renewal = setInterval(() => {
      this.store.renew(decision.claim).catch((error: unknown) => {
        this.logger.warn({ err: error }, 'idempotency lease renewal failed');
      });
    }, RENEW_INTERVAL_MS);
    renewal.unref();

    let body: unknown;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (error) {
      clearInterval(renewal);
      if (isSafeToRelease(error)) await this.#release(decision.claim);
      throw error;
    }
    clearInterval(renewal);
    try {
      await this.store.complete(decision.claim, body);
    } catch (error) {
      // The handler succeeded, so its response is the truth. Without a stored copy a retry
      // re-runs the handler after the lease lapses, and the ledger key makes that a replay.
      this.logger.error({ err: error }, 'idempotency response could not be stored');
    }
    return body;
  }

  async #release(claim: IdempotencyClaim): Promise<void> {
    try {
      await this.store.release(claim);
    } catch (error) {
      // The handler's own error is the one the client needs; the claim lapses with its lease.
      this.logger.warn({ err: error }, 'idempotency claim could not be released');
    }
  }
}
