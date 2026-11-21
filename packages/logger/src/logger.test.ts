import { describe, expect, it } from 'vitest';

import { createLogger, type LogLevel } from './logger.js';
import { REDACTED } from './redact.js';
import { RequestContext } from './request-context.js';

function setup(level: LogLevel = 'info') {
  const lines: Record<string, unknown>[] = [];
  const context = new RequestContext();
  const logger = createLogger({
    service: 'api',
    level,
    context,
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { lines, context, logger };
}

describe('createLogger', () => {
  it('writes JSON with service, level label, ISO time, and message', () => {
    const { lines, logger } = setup();

    logger.info('started');

    expect(lines[0]).toMatchObject({ service: 'api', level: 'info', msg: 'started' });
    expect(new Date(String(lines[0]?.['time'])).toISOString()).toBe(lines[0]?.['time']);
  });

  it('adds the request ID inside a request scope, including across awaits', async () => {
    const { lines, context, logger } = setup();

    await context.run({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      logger.info('inside');
    });
    logger.info('outside');

    expect(lines.map((line) => line['requestId'])).toEqual(['req-1', undefined]);
  });

  it('adds the request ID after enter() for the rest of the async execution', async () => {
    const { lines, context, logger } = setup();

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        context.enter({ requestId: 'req-2' });
        void Promise.resolve().then(() => {
          logger.info('later');
          resolve();
        });
      });
    });

    expect(lines[0]?.['requestId']).toBe('req-2');
  });

  it('redacts sensitive fields in log payloads', () => {
    const { lines, logger } = setup();

    logger.info({ email: 'a@b.c', userId: 'u_1', headers: { authorization: 'Bearer x' } }, 'login');

    expect(lines[0]).toMatchObject({
      email: REDACTED,
      userId: 'u_1',
      headers: { authorization: REDACTED },
    });
  });

  it('redacts sensitive child bindings', () => {
    const { lines, logger } = setup();

    logger.child({ apiKey: 'k', vendor: 'kyc' }).info('call');

    expect(lines[0]).toMatchObject({ apiKey: REDACTED, vendor: 'kyc' });
  });

  it('logs errors with redacted fields', () => {
    const { lines, logger } = setup();

    logger.error({ err: Object.assign(new Error('boom'), { otp: '123456' }) }, 'failed');

    expect(lines[0]).toMatchObject({ err: { type: 'Error', message: 'boom', otp: REDACTED } });
  });

  it('logs bigint amounts without throwing', () => {
    const { lines, logger } = setup();

    logger.info({ amountUnits: 5n }, 'credit');

    expect(lines[0]).toMatchObject({ amountUnits: '5' });
  });

  it('drops lines below the configured level', () => {
    const { lines, logger } = setup('warn');

    logger.info('hidden');
    logger.warn('shown');

    expect(lines.map((line) => line['msg'])).toEqual(['shown']);
  });

  it('writes to stdout when no destination is given', () => {
    const logger = createLogger({ service: 'api', level: 'silent', context: new RequestContext() });

    expect(logger.level).toBe('silent');
  });
});

describe('child loggers', () => {
  it('redacts bindings on grandchildren and keeps parent bindings', () => {
    const { lines, logger } = setup();

    logger.child({ vendor: 'kyc' }).child({ webhookSecret: 's', jobId: 'j_1' }).info('call');

    expect(lines[0]).toMatchObject({
      service: 'api',
      vendor: 'kyc',
      webhookSecret: REDACTED,
      jobId: 'j_1',
    });
  });
});
