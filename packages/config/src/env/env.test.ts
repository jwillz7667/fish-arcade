import { ConfigError } from '@reef/errors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiEnvSchema, gameServerEnvSchema, workersEnvSchema } from './app-schemas.js';
import { defineEnvSchema, DEV_ONLY_MESSAGE } from './define-env-schema.js';
import { formatConfigError, loadEnv, parseEnv, type EnvSource } from './load-env.js';

const SECRET = 'hunter2-do-not-print';

const DEV_API_ENV: EnvSource = {
  NODE_ENV: 'development',
  API_PORT: '4000',
  DATABASE_URL: `postgresql://reef:${SECRET}@127.0.0.1:5432/reef`,
  REDIS_URL: `redis://:${SECRET}@127.0.0.1:6379`,
  FIELD_ENCRYPTION_PROVIDER: 'local',
  FIELD_ENCRYPTION_LOCAL_KEY_FILE: '.keys/dev/field-master.key',
  BLIND_INDEX_KEY_FILE: '.keys/dev/blind-index.key',
  CORS_ORIGINS: 'http://localhost:3000',
  AUTH_JWT_PRIVATE_KEY_FILE: '.keys/dev/auth-jwt.pem',
  AUTH_JWT_KEY_ID: 'dev-1',
  AUTH_HMAC_KEY_FILE: '.keys/dev/auth-hmac.key',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGINS: 'http://localhost:3000',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  EMAIL_PROVIDER: 'mailpit',
  SMS_PROVIDER: 'mailpit',
  GEO_PROVIDER: 'dev_stub',
};

const PROD_API_ENV: EnvSource = {
  NODE_ENV: 'production',
  API_PORT: '4000',
  DATABASE_URL: `postgresql://reef:${SECRET}@db.internal:5432/reef?sslmode=verify-full`,
  REDIS_URL: `rediss://:${SECRET}@cache.internal:6379`,
  FIELD_ENCRYPTION_PROVIDER: 'kms',
  FIELD_ENCRYPTION_KMS_KEY_ID: 'alias/reef-fields',
  BLIND_INDEX_KEY: SECRET,
  CORS_ORIGINS: 'https://play.example.com,https://admin.example.com',
  AUTH_JWT_PRIVATE_KEY: SECRET,
  AUTH_JWT_KEY_ID: 'prod-2026-11',
  AUTH_HMAC_KEY: SECRET,
  WEBAUTHN_RP_ID: 'play.example.com',
  WEBAUTHN_ORIGINS: 'https://play.example.com',
  TURNSTILE_SECRET_KEY: SECRET,
  EMAIL_PROVIDER: 'mailpit',
  SMS_PROVIDER: 'mailpit',
  GEO_PROVIDER: 'dev_stub',
};

// Only dev-only messaging and geo providers exist so far, so production fails on these three
// until vendor adapters land. Other production checks are asserted without them.
const MESSAGING_PROVIDERS = new Set(['EMAIL_PROVIDER', 'SMS_PROVIDER', 'GEO_PROVIDER']);

function captureConfigError(schema: z.ZodType, source: EnvSource): ConfigError | undefined {
  try {
    parseEnv(schema, source);
    return undefined;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error;
  }
}

function issuePaths(schema: z.ZodType, source: EnvSource): string[] {
  return (captureConfigError(schema, source)?.issues ?? []).map((issue) => issue.path);
}

function prodIssuePaths(source: EnvSource): string[] {
  return issuePaths(apiEnvSchema, source).filter((path) => !MESSAGING_PROVIDERS.has(path));
}

describe('parseEnv', () => {
  it('parses a valid dev env and applies defaults', () => {
    expect(parseEnv(apiEnvSchema, DEV_API_ENV)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_PORT: 4000,
    });
  });

  it('accepts a production env that uses TLS, apart from the dev-only messaging providers', () => {
    expect(issuePaths(apiEnvSchema, PROD_API_ENV)).toEqual([
      'EMAIL_PROVIDER',
      'SMS_PROVIDER',
      'GEO_PROVIDER',
    ]);
  });

  it('names every missing variable', () => {
    expect(issuePaths(apiEnvSchema, {})).toEqual([
      'NODE_ENV',
      'API_PORT',
      'CORS_ORIGINS',
      'DATABASE_URL',
      'REDIS_URL',
      'FIELD_ENCRYPTION_PROVIDER',
      'AUTH_JWT_KEY_ID',
      'WEBAUTHN_RP_ID',
      'WEBAUTHN_ORIGINS',
      'TURNSTILE_SECRET_KEY',
      'EMAIL_PROVIDER',
      'SMS_PROVIDER',
      'GEO_PROVIDER',
    ]);
  });

  it('applies geo defaults', () => {
    expect(parseEnv(apiEnvSchema, DEV_API_ENV)).toMatchObject({
      GEO_MIN_CONFIDENCE: 0.9,
      GEO_PROVIDER_TIMEOUT_MS: 3_000,
      GEO_TOKEN_TTL_SECONDS: 600,
    });
  });

  it('parses auth settings and applies their defaults', () => {
    expect(parseEnv(apiEnvSchema, DEV_API_ENV)).toMatchObject({
      AUTH_REFRESH_TTL_DAYS: 30,
      HIBP_ENABLED: true,
      WEBAUTHN_ORIGINS: ['http://localhost:3000'],
      MAILPIT_URL: 'http://127.0.0.1:8025',
    });
  });

  it('turns HIBP_ENABLED=false into a false flag', () => {
    expect(parseEnv(apiEnvSchema, { ...DEV_API_ENV, HIBP_ENABLED: 'false' }).HIBP_ENABLED).toBe(
      false,
    );
  });

  it('parses CORS origins and applies HTTP defaults', () => {
    const source = { ...DEV_API_ENV, CORS_ORIGINS: PROD_API_ENV['CORS_ORIGINS'] };

    expect(parseEnv(apiEnvSchema, source)).toMatchObject({
      CORS_ORIGINS: ['https://play.example.com', 'https://admin.example.com'],
      API_HOST: '0.0.0.0',
      TRUST_PROXY_HOPS: 0,
      RATE_LIMIT_PER_MINUTE: 300,
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it.each(['*', 'https://play.example.com/path', 'ftp://x.example.com', ' , '])(
    'rejects CORS_ORIGINS=%j',
    (value) => {
      const paths = issuePaths(apiEnvSchema, { ...DEV_API_ENV, CORS_ORIGINS: value });

      expect([...new Set(paths.map((path) => path.split('.')[0]))]).toEqual(['CORS_ORIGINS']);
    },
  );

  it('rejects plain-http CORS origins in production', () => {
    expect(prodIssuePaths({ ...PROD_API_ENV, CORS_ORIGINS: 'http://play.example.com' })).toEqual([
      'CORS_ORIGINS',
    ]);
  });

  it.each([
    ['API_PORT', 'not-a-port'],
    ['API_PORT', '70000'],
    ['DATABASE_URL', 'mysql://x@y/z'],
    ['REDIS_URL', 'http://cache'],
    ['LOG_LEVEL', 'verbose'],
    ['NODE_ENV', 'staging'],
  ])('rejects an invalid %s', (key, value) => {
    expect(issuePaths(apiEnvSchema, { ...DEV_API_ENV, [key]: value })).toEqual([key]);
  });

  it('never includes values in the error', () => {
    const source = { ...DEV_API_ENV, NODE_ENV: SECRET, API_PORT: SECRET, LOG_LEVEL: SECRET };

    const error = captureConfigError(apiEnvSchema, source);

    expect(error).toBeInstanceOf(ConfigError);
    expect(JSON.stringify(error?.issues)).not.toContain(SECRET);
    expect(error?.message).not.toContain(SECRET);
    expect(error && formatConfigError(error)).not.toContain(SECRET);
  });
});

describe('dev-only settings in production', () => {
  it.each([
    ['DATABASE_URL', 'postgresql://reef:x@db.internal:5432/reef'],
    ['DATABASE_URL', 'postgresql://reef:x@db.internal:5432/reef?sslmode=disable'],
    ['DATABASE_URL', 'postgresql://reef:x@db.internal:5432/reef?sslmode=prefer'],
    ['REDIS_URL', 'redis://:x@cache.internal:6379'],
  ])('rejects plaintext %s', (key, value) => {
    const paths = prodIssuePaths({ ...PROD_API_ENV, [key]: value });

    expect(paths).toEqual([key]);
  });

  it('rejects local field-encryption keys in production', () => {
    const paths = prodIssuePaths({
      ...PROD_API_ENV,
      FIELD_ENCRYPTION_PROVIDER: 'local',
      FIELD_ENCRYPTION_LOCAL_KEY_FILE: 'master.key',
      BLIND_INDEX_KEY_FILE: 'index.key',
    });

    expect(paths.sort()).toEqual([
      'BLIND_INDEX_KEY_FILE',
      'FIELD_ENCRYPTION_LOCAL_KEY_FILE',
      'FIELD_ENCRYPTION_PROVIDER',
    ]);
  });

  it.each([
    ['AUTH_JWT_PRIVATE_KEY_FILE', 'jwt.pem'],
    ['AUTH_HMAC_KEY_FILE', 'hmac.key'],
    ['TURNSTILE_SECRET_KEY', '1x0000000000000000000000000000000AA'],
    ['EMAIL_PROVIDER', 'mailpit'],
    ['SMS_PROVIDER', 'mailpit'],
    ['WEBAUTHN_ORIGINS', 'http://play.example.com'],
    ['GEO_PROVIDER', 'dev_stub'],
  ])('rejects the dev-only auth setting %s in production', (key, value) => {
    expect(issuePaths(apiEnvSchema, { ...PROD_API_ENV, [key]: value })).toContain(key);
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])(
    'reports a malformed %s in production instead of crashing',
    (key) => {
      expect(prodIssuePaths({ ...PROD_API_ENV, [key]: 'not a url' })).toEqual([key]);
    },
  );

  it('allows plaintext connections outside production', () => {
    expect(issuePaths(apiEnvSchema, DEV_API_ENV)).toEqual([]);
  });

  it('rejects a custom dev-only flag in production with the dev-only message', () => {
    const schema = defineEnvSchema(
      { GEO_PROVIDER: z.enum(['stub', 'vendor']) },
      { GEO_PROVIDER: (value) => value === 'stub' },
    );

    const error = captureConfigError(schema, { NODE_ENV: 'production', GEO_PROVIDER: 'stub' });

    expect(error?.issues).toEqual([{ path: 'GEO_PROVIDER', message: DEV_ONLY_MESSAGE }]);
  });

  it('accepts the same flag in development and a production value in production', () => {
    const schema = defineEnvSchema(
      { GEO_PROVIDER: z.enum(['stub', 'vendor']) },
      { GEO_PROVIDER: (value) => value === 'stub' },
    );

    expect([
      issuePaths(schema, { NODE_ENV: 'test', GEO_PROVIDER: 'stub' }),
      issuePaths(schema, { NODE_ENV: 'production', GEO_PROVIDER: 'vendor' }),
    ]).toEqual([[], []]);
  });
});

describe('app schemas', () => {
  it('parses the workers env', () => {
    const workers = { ...DEV_API_ENV, API_PORT: undefined };

    expect(parseEnv(workersEnvSchema, workers).REDIS_URL).toContain('redis://');
  });

  it('parses the game-server env and requires TLS Redis in production', () => {
    const source = {
      NODE_ENV: 'production',
      GAME_SERVER_PORT: '4100',
      REDIS_URL: 'redis://cache:6379',
    };

    expect([
      issuePaths(gameServerEnvSchema, source),
      issuePaths(gameServerEnvSchema, { ...source, REDIS_URL: 'rediss://cache:6379' }),
    ]).toEqual([['REDIS_URL'], []]);
  });
});

describe('loadEnv', () => {
  class ExitCalled extends Error {
    constructor(readonly code: number) {
      super(`exit ${String(code)}`);
    }
  }

  function io(source: EnvSource) {
    const written: string[] = [];
    return {
      written,
      io: {
        source,
        stderr: { write: (text: string) => written.push(text) },
        exit: (code: number): never => {
          throw new ExitCalled(code);
        },
      },
    };
  }

  it('returns the parsed env when valid', () => {
    const { io: hooks, written } = io(DEV_API_ENV);

    expect([loadEnv(apiEnvSchema, hooks).API_PORT, written]).toEqual([4000, []]);
  });

  it('prints variable names, not values, and exits with code 1', () => {
    const { io: hooks, written } = io({
      ...DEV_API_ENV,
      API_PORT: SECRET,
      DATABASE_URL: undefined,
    });

    expect(() => loadEnv(apiEnvSchema, hooks)).toThrow(expect.objectContaining({ code: 1 }));
    expect(written.join('')).toMatch(/API_PORT[\s\S]*DATABASE_URL/);
    expect(written.join('')).not.toContain(SECRET);
  });

  it('rethrows errors that are not configuration errors', () => {
    const { io: hooks } = io(DEV_API_ENV);
    const broken = z.unknown().transform(() => {
      throw new TypeError('bug');
    });

    expect(() => loadEnv(broken, { ...hooks, source: DEV_API_ENV })).toThrow(TypeError);
  });
});
