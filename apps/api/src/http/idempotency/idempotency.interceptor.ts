import { createHash } from 'node:crypto';

import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthError, ValidationError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, type Observable } from 'rxjs';

import { principalOf } from '../principal.js';
import { canonicalJson } from './canonical-json.js';
import { IdempotencyStore } from './idempotency-store.js';
import { MONEY_ROUTE } from './money-route.decorator.js';

const KEY_PATTERN = /^[A-Za-z0-9_:-]{8,128}$/;

function requestHash(request: FastifyRequest): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.url}\n${canonicalJson(request.body ?? null)}`, 'utf8')
    .digest('hex');
}

/** Enforces idempotency on routes marked `@MoneyRoute()` (playbook Step 5). */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdempotencyStore) private readonly store: IdempotencyStore,
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
    const principal = principalOf(request);
    if (principal === undefined) throw new AuthError();

    const scope = `${principal.userId}:${key}`;
    const hash = requestHash(request);
    const decision = await this.store.begin(scope, hash);
    if (decision.kind === 'replay') {
      void http.getResponse<FastifyReply>().header('idempotent-replayed', 'true');
      return decision.body;
    }
    try {
      const body = await new Promise<unknown>((resolve, reject) => {
        let last: unknown;
        next.handle().subscribe({
          next: (value) => {
            last = value;
          },
          error: reject,
          complete: () => {
            resolve(last);
          },
        });
      });
      await this.store.complete(scope, hash, body);
      return body;
    } catch (error) {
      await this.store.abandon(scope);
      throw error;
    }
  }
}
