import { RateLimitedError, ValidationError } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from './error-response.js';

describe('toErrorResponse', () => {
  it('keeps a DomainError code, status, safe message, and issues', () => {
    const error = new ValidationError({
      message: 'internal detail',
      issues: [{ path: 'a', message: 'bad' }],
    });

    expect(toErrorResponse(error, 'r1')).toEqual({
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request is invalid.',
          requestId: 'r1',
          issues: [{ path: 'a', message: 'bad' }],
        },
      },
      headers: {},
      isServerError: false,
    });
  });

  it('adds Retry-After for rate limits', () => {
    expect(toErrorResponse(new RateLimitedError({ retryAfterSeconds: 7 }), 'r').headers).toEqual({
      'retry-after': '7',
    });
    expect(toErrorResponse(new RateLimitedError(), 'r').headers).toEqual({});
  });

  it.each([
    [{ statusCode: 404 }, 404, 'NOT_FOUND'],
    [{ status: 405 }, 405, 'NOT_FOUND'],
    [{ statusCode: 413 }, 413, 'VALIDATION_FAILED'],
    [{ statusCode: 429 }, 429, 'RATE_LIMITED'],
  ])('maps framework error %o to %s %s', (error, status, code) => {
    const response = toErrorResponse(error, 'r');

    expect([response.status, response.body.error.code, response.isServerError]).toEqual([
      status,
      code,
      false,
    ]);
  });

  it.each([
    new Error('secret detail'),
    { statusCode: 502 },
    { statusCode: 'x' },
    'string',
    null,
    { statusCode: 200 },
  ])('turns %o into a generic 500', (error) => {
    expect(toErrorResponse(error, 'r')).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Something went wrong.', requestId: 'r' } },
      headers: {},
      isServerError: true,
    });
  });
});
