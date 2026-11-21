import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConflictError, DependencyUnavailableError, InsufficientFundsError } from '@reef/errors';
import { createLogger, RequestContext } from '@reef/logger';
import type { FastifyRequest } from 'fastify';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type {
  IdempotencyClaim,
  IdempotencyClaims,
  IdempotencyDecision,
} from './idempotency-store.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { MONEY_ROUTE, MoneyRoute, moneyRouteKeyOf } from './money-route.decorator.js';

class FakeClaims implements IdempotencyClaims {
  readonly calls: string[] = [];
  failOn: 'complete' | 'release' | undefined;

  begin(scope: string, requestHash: string): Promise<IdempotencyDecision> {
    this.calls.push('begin');
    return Promise.resolve({ kind: 'execute', claim: { key: scope, requestHash, record: 'r' } });
  }

  renew(): Promise<void> {
    return Promise.resolve();
  }

  complete(_claim: IdempotencyClaim, body: unknown): Promise<void> {
    this.calls.push(`complete:${JSON.stringify(body)}`);
    return this.failOn === 'complete' ? Promise.reject(new Error('redis down')) : Promise.resolve();
  }

  release(): Promise<void> {
    this.calls.push('release');
    return this.failOn === 'release' ? Promise.reject(new Error('redis down')) : Promise.resolve();
  }
}

// A route handler marked the way @MoneyRoute marks a controller method.
const moneyHandler = (): void => undefined;
MoneyRoute()(Object.prototype, 'money', { value: moneyHandler });

function setup(failOn?: 'complete' | 'release') {
  const store = new FakeClaims();
  store.failOn = failOn;
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'warn',
    context: new RequestContext(),
    destination: { write: (line: string) => logs.push(line) },
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, logger);
  const request = {
    method: 'POST',
    url: '/v1/test',
    body: { amount: '1' },
    headers: { 'idempotency-key': 'retry-retry' },
    principal: { userId: 'u-1', sessionId: 's-1', authTime: new Date(), amr: ['pwd'] },
  } as unknown as FastifyRequest;
  const context = {
    getHandler: () => moneyHandler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
  const run = (handler: CallHandler) => lastValueFrom(interceptor.intercept(context, handler));
  return { store, logs, request, run };
}

describe('IdempotencyInterceptor', () => {
  it('stores the response and exposes the scoped key to the handler', async () => {
    const { store, request, run } = setup();

    const body = await run({ handle: () => of({ ok: true }) });

    expect(body).toEqual({ ok: true });
    expect(store.calls).toEqual(['begin', 'complete:{"ok":true}']);
    expect(moneyRouteKeyOf(request)).toBe('player:u-1:retry-retry');
  });

  it('returns the response even when storing it fails, and keeps the claim', async () => {
    const { store, logs, run } = setup('complete');

    const body = await run({ handle: () => of({ ok: true }) });

    expect(body).toEqual({ ok: true });
    expect(store.calls).not.toContain('release');
    expect(logs.join('')).toContain('idempotency response could not be stored');
  });

  it('releases the key after a 4xx domain error, which moves no money', async () => {
    const { store, run } = setup();

    await expect(
      run({ handle: () => throwError(() => new InsufficientFundsError()) }),
    ).rejects.toThrow(InsufficientFundsError);
    expect(store.calls).toEqual(['begin', 'release']);
  });

  it.each([
    ['an unknown error', new Error('socket hang up')],
    ['a dependency failure', new DependencyUnavailableError({ dependency: 'postgres' })],
  ])('keeps the claim after %s, which may follow a commit', async (_label, error) => {
    const { store, run } = setup();

    await expect(run({ handle: () => throwError(() => error) })).rejects.toBe(error);
    expect(store.calls).toEqual(['begin']);
  });

  it("reports the handler's error when releasing the claim also fails", async () => {
    const { run } = setup('release');
    const error = new ConflictError();

    await expect(run({ handle: () => throwError(() => error) })).rejects.toBe(error);
  });

  it('marks routes with metadata', () => {
    expect(new Reflector().get(MONEY_ROUTE, moneyHandler)).toBe(true);
  });
});
