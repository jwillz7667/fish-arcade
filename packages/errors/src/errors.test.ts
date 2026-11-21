import { describe, expect, it } from 'vitest';

import {
  AuthError,
  ComplianceBlockedError,
  ConfigError,
  ConflictError,
  DEFAULT_SAFE_MESSAGES,
  DependencyUnavailableError,
  DomainError,
  ErrorCode,
  ForbiddenError,
  InsufficientFundsError,
  isDomainError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from './index.js';

describe('DomainError subclasses', () => {
  it.each([
    [new ValidationError(), ErrorCode.VALIDATION_FAILED, 400],
    [new AuthError(), ErrorCode.UNAUTHENTICATED, 401],
    [new ForbiddenError(), ErrorCode.FORBIDDEN, 403],
    [new NotFoundError(), ErrorCode.NOT_FOUND, 404],
    [new ConflictError(), ErrorCode.CONFLICT, 409],
    [new RateLimitedError(), ErrorCode.RATE_LIMITED, 429],
    [new ComplianceBlockedError(), ErrorCode.COMPLIANCE_BLOCKED, 403],
    [new InsufficientFundsError(), ErrorCode.INSUFFICIENT_FUNDS, 422],
    [
      new DependencyUnavailableError({ dependency: 'price-oracle' }),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      503,
    ],
    [new ConfigError({ issues: [] }), ErrorCode.CONFIG_INVALID, 500],
  ])('%s carries its code and status', (error, code, status) => {
    expect({ code: error.code, status: error.httpStatus, name: error.name }).toEqual({
      code,
      status,
      name: error.constructor.name,
    });
  });

  it('defaults both messages to the catalog safe message', () => {
    const error = new NotFoundError();

    expect([error.message, error.safeMessage]).toEqual([
      DEFAULT_SAFE_MESSAGES.NOT_FOUND,
      DEFAULT_SAFE_MESSAGES.NOT_FOUND,
    ]);
  });

  it('keeps the internal message separate from the safe message', () => {
    const error = new AuthError({ message: 'refresh token family 42 revoked' });

    expect([error.message, error.safeMessage]).toEqual([
      'refresh token family 42 revoked',
      DEFAULT_SAFE_MESSAGES.UNAUTHENTICATED,
    ]);
  });

  it('uses an explicit safe message when given', () => {
    const error = new ForbiddenError({ safeMessage: 'Admins only.' });

    expect(error.safeMessage).toBe('Admins only.');
  });

  it('preserves the cause', () => {
    const cause = new Error('socket hang up');

    const error = new DependencyUnavailableError({ dependency: 'redis', cause });

    expect(error.cause).toBe(cause);
  });

  it('sets no cause when none is given', () => {
    expect('cause' in new ConflictError()).toBe(false);
  });

  it('accepts a narrower code within the same family', () => {
    const validation = new ValidationError({ code: ErrorCode.INVALID_AMOUNT });
    const conflict = new ConflictError({ code: ErrorCode.IDEMPOTENCY_CONFLICT });

    expect([validation.code, conflict.code]).toEqual([
      ErrorCode.INVALID_AMOUNT,
      ErrorCode.IDEMPOTENCY_CONFLICT,
    ]);
  });

  it('carries subclass-specific details', () => {
    const issues = [{ path: 'email', message: 'Required' }];

    expect({
      validation: new ValidationError({ issues }).issues,
      config: new ConfigError({ issues }).issues,
      retry: new RateLimitedError({ retryAfterSeconds: 30 }).retryAfterSeconds,
      dependency: new DependencyUnavailableError({ dependency: 'kyc' }).dependency,
    }).toEqual({ validation: issues, config: issues, retry: 30, dependency: 'kyc' });
  });
});

describe('isDomainError', () => {
  it('recognises domain errors and rejects everything else', () => {
    expect([
      isDomainError(new ValidationError()),
      isDomainError(new Error('plain')),
      isDomainError('string'),
      isDomainError(undefined),
    ]).toEqual([true, false, false, false]);
  });

  it('keeps the prototype chain for instanceof checks', () => {
    const error = new InsufficientFundsError();

    expect([error instanceof DomainError, error instanceof Error]).toEqual([true, true]);
  });
});
