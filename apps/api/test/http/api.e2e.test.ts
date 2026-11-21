import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, calls, testEnv, type TestApp } from './test-app.js';

let main: TestApp;

beforeAll(async () => {
  const redis = new Redis(inject('redisUrl'));
  await redis.flushdb();
  await redis.quit();
  main = await buildTestApp();
});

afterAll(async () => {
  await main.app.close();
});

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify(body),
});

describe('health and readiness', () => {
  it('reports liveness with security headers and a request ID', async () => {
    const response = await main.app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is ready when Postgres and Redis answer', async () => {
    const response = await main.app.inject({ method: 'GET', url: '/v1/ready' });

    expect([response.statusCode, response.json()]).toEqual([
      200,
      { status: 'ready', checks: { postgres: 'up', redis: 'up' } },
    ]);
  });

  it('is not ready, with 503, when Redis is down', async () => {
    const down = await buildTestApp(testEnv(), 'redis://127.0.0.1:1/0');
    try {
      const response = await down.app.inject({ method: 'GET', url: '/v1/ready' });

      expect([response.statusCode, response.json()]).toEqual([
        503,
        { status: 'not_ready', checks: { postgres: 'up', redis: 'down' } },
      ]);
    } finally {
      await down.app.close();
    }
  });

  it('fails closed on rate-limited routes when Redis is down', async () => {
    const down = await buildTestApp(testEnv(), 'redis://127.0.0.1:1/0');
    try {
      const response = await down.app.inject({ method: 'GET', url: '/v1/test/limited' });

      expect([response.statusCode, response.json<ErrorBody>().error.code]).toEqual([
        503,
        'DEPENDENCY_UNAVAILABLE',
      ]);
    } finally {
      await down.app.close();
    }
  });
});

describe('error shape', () => {
  it('returns field issues for a validation error, without echoing the value', async () => {
    const response = await main.app.inject({
      method: 'POST',
      url: '/v1/test/validate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 'DROP TABLE users' }),
    });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request is invalid.',
        requestId: response.headers['x-request-id'],
        issues: [{ path: 'amount', message: expect.any(String) }],
      },
    });
    expect(response.body).not.toContain('DROP TABLE');
  });

  it('passes valid input through parsed', async () => {
    const response = await main.app.inject({
      method: 'POST',
      url: '/v1/test/validate',
      ...json({ amount: '12' }),
    });

    expect([response.statusCode, response.json()]).toEqual([201, { ok: true, amount: '12' }]);
  });

  it('returns the same shape for malformed JSON and unknown routes', async () => {
    const malformed = await main.app.inject({
      method: 'POST',
      url: '/v1/test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"amount":',
    });
    const missing = await main.app.inject({ method: 'GET', url: '/v1/nope' });

    expect([malformed.statusCode, malformed.json<ErrorBody>().error.code]).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect([missing.statusCode, missing.json<ErrorBody>().error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('turns an unexpected error into a generic 500 with no internal detail', async () => {
    const response = await main.app.inject({ method: 'GET', url: '/v1/test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong.',
        requestId: response.headers['x-request-id'],
      },
    });
    for (const leak of ['db-internal', '5432', 'pool.js', 'Error', 'stack']) {
      expect(response.body).not.toContain(leak);
    }
    expect(main.logs.some((line) => line['msg'] === 'request failed')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once a route limit is exceeded', async () => {
    const statuses: number[] = [];
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await main.app.inject({ method: 'GET', url: '/v1/test/limited' });
      statuses.push(last.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.json<ErrorBody>().error.code).toBe('RATE_LIMITED');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('enforces the global per-IP limit, using the client IP behind a trusted proxy', async () => {
    const limited = await buildTestApp(
      testEnv({ RATE_LIMIT_PER_MINUTE: '3', TRUST_PROXY_HOPS: '1' }),
    );
    try {
      const from = (ip: string) =>
        limited.app.inject({
          method: 'GET',
          url: '/v1/test/log',
          headers: { 'x-forwarded-for': ip },
        });
      const statuses = [];
      for (let attempt = 0; attempt < 4; attempt += 1)
        statuses.push((await from(`10.0.${String(attempt)}.1`)).statusCode);
      const oneIp = [];
      for (let attempt = 0; attempt < 4; attempt += 1)
        oneIp.push((await from('10.9.9.9')).statusCode);

      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(oneIp).toEqual([200, 200, 200, 429]);
    } finally {
      await limited.app.close();
    }
  });

  it('never rate limits health probes', async () => {
    const limited = await buildTestApp(testEnv({ RATE_LIMIT_PER_MINUTE: '1' }));
    try {
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        statuses.push((await limited.app.inject({ method: 'GET', url: '/v1/health' })).statusCode);
      }

      expect(statuses).toEqual([200, 200, 200]);
    } finally {
      await limited.app.close();
    }
  });
});

describe('idempotent money routes', () => {
  const [userOne, userA, userB] = [randomUUID(), randomUUID(), randomUUID()];
  const post = async (key: string | undefined, body: unknown, user: string | null = userOne) =>
    main.app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
        ...(user === null ? {} : { authorization: await main.bearerFor(user) }),
      },
      payload: JSON.stringify(body),
    });

  it('replays the stored response on retry without running the handler again', async () => {
    const key = `key-${randomUUID()}`;
    const before = calls.echo;

    const first = await post(key, { amount: '5', note: 'a' });
    const retry = await post(key, { note: 'a', amount: '5' });

    expect([first.statusCode, retry.statusCode]).toEqual([201, 201]);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(calls.echo - before).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = `key-${randomUUID()}`;
    await post(key, { amount: '5' });

    const response = await post(key, { amount: '6' });

    expect([response.statusCode, response.json<ErrorBody>().error.code]).toEqual([
      409,
      'IDEMPOTENCY_CONFLICT',
    ]);
  });

  it('rejects a concurrent duplicate while the first is running', async () => {
    const key = `key-${randomUUID()}`;

    const responses = await Promise.all([post(key, { amount: '1' }), post(key, { amount: '1' })]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });

  it('scopes keys per user', async () => {
    const key = `key-${randomUUID()}`;

    const [a, b] = [
      await post(key, { amount: '1' }, userA),
      await post(key, { amount: '1' }, userB),
    ];

    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('requires a well-formed Idempotency-Key header and an authenticated caller', async () => {
    const missing = await post(undefined, { amount: '1' });
    const malformed = await post('short', { amount: '1' });
    const anonymous = await post(`key-${randomUUID()}`, { amount: '1' }, null);

    expect([missing.statusCode, malformed.statusCode, anonymous.statusCode]).toEqual([
      400, 400, 401,
    ]);
  });

  it('lets the client retry after the handler failed validation', async () => {
    const key = `key-${randomUUID()}`;
    const bad = await post(key, { amount: 'x' });

    const good = await post(key, { amount: 'x' });

    expect([bad.statusCode, good.statusCode]).toEqual([400, 400]);
    expect(good.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('request IDs, CORS, and OpenAPI', () => {
  it('echoes a valid upstream request ID and tags every log line with it', async () => {
    const requestId = `lb-${randomUUID()}`;

    const response = await main.app.inject({
      method: 'GET',
      url: '/v1/test/log',
      headers: { 'x-request-id': requestId },
    });
    const lines = main.logs.filter((line) => line['requestId'] === requestId);

    expect(response.headers['x-request-id']).toBe(requestId);
    expect(lines.map((line) => line['msg'])).toEqual(['inside handler', 'request completed']);
  });

  it('replaces a malformed upstream request ID', async () => {
    const response = await main.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': 'x\ny' },
    });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows only allowlisted origins', async () => {
    const allowed = await main.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { origin: 'http://localhost:3000' },
    });
    const denied = await main.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves OpenAPI outside production only', async () => {
    // Applied after validation: production env cannot parse until a vendor messaging
    // provider exists (Mailpit is dev-only).
    const prod = await buildTestApp(testEnv(), 'redis://127.0.0.1:1/0', {
      NODE_ENV: 'production',
    });
    try {
      const dev = await main.app.inject({ method: 'GET', url: '/v1/openapi.json' });
      const production = await prod.app.inject({ method: 'GET', url: '/v1/openapi.json' });

      expect([dev.statusCode, dev.json<{ info: { title: string } }>().info.title]).toEqual([
        200,
        'Reef API',
      ]);
      expect(production.statusCode).toBe(404);
    } finally {
      await prod.app.close();
    }
  });
});

describe('graceful shutdown', () => {
  it('finishes in-flight requests before closing', async () => {
    const live = await buildTestApp();
    await live.app.listen({ port: 0, host: '127.0.0.1' });
    const address = live.app.getHttpServer().address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const inFlight = fetch(`http://127.0.0.1:${String(port)}/v1/test/slow`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = live.app.close();
    const response = await inFlight;
    await closing;

    expect([response.status, await response.json()]).toEqual([200, { ok: true }]);
    await expect(fetch(`http://127.0.0.1:${String(port)}/v1/health`)).rejects.toThrow();
  });
});
