import { ConfigError } from '@reef/errors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiEnvSchema, gameServerEnvSchema, workersEnvSchema } from './app-schemas.js';
import { defineEnvSchema, DEV_ONLY_MESSAGE } from './define-env-schema.js';
import { formatConfigError, loadEnv, parseEnv, type EnvSource } from './load-env.js';

const SECRET = 'hunter2-do-not-print';

const DEV_API_ENV: EnvSource = {
  NODE_ENV: 'development',
  BITCOIN_NETWORK: 'regtest',
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
  KYC_PROVIDER: 'dev_stub',
  KYC_WEBHOOK_SECRET: 'dev-kyc-webhook-secret-at-least-32-chars',
  CHAIN_RISK_PROVIDER: 'dev_stub',
  ADMIN_LOGIN_MODE: 'dev_local',
  ADMIN_ALLOWED_EMAIL_DOMAINS: 'reef.local',
  ADMIN_WEB_ORIGIN: 'http://localhost:3001',
};

const PROD_API_ENV: EnvSource = {
  BITCOIN_NETWORK: 'mainnet',
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
  KYC_PROVIDER: 'dev_stub',
  KYC_WEBHOOK_SECRET: `${SECRET}-${SECRET}-${SECRET}`,
  CHAIN_RISK_PROVIDER: 'trm_labs',
  TRM_API_KEY: SECRET,
  TRUST_PROXY_HOPS: '1',
  ADMIN_LOGIN_MODE: 'oidc',
  ADMIN_OIDC_ISSUER: 'https://sso.example.com',
  ADMIN_OIDC_CLIENT_ID: 'reef-admin',
  ADMIN_OIDC_CLIENT_SECRET: SECRET,
  ADMIN_OIDC_REDIRECT_URI: 'https://api.example.com/v1/admin/auth/oidc/callback',
  ADMIN_ALLOWED_EMAIL_DOMAINS: 'example.com',
  ADMIN_WEB_ORIGIN: 'https://admin.example.com',
  ADMIN_IP_ALLOWLIST: '203.0.113.0/24',
};

// Only dev-only messaging, geo, and KYC providers exist so far, so production fails on these
// until vendor adapters land. Other production checks are asserted without them.
const MESSAGING_PROVIDERS = new Set([
  'EMAIL_PROVIDER',
  'SMS_PROVIDER',
  'GEO_PROVIDER',
  'KYC_PROVIDER',
]);

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

  it('accepts a production env that uses TLS, apart from the dev-only providers', () => {
    expect(issuePaths(apiEnvSchema, PROD_API_ENV)).toEqual([
      'EMAIL_PROVIDER',
      'SMS_PROVIDER',
      'GEO_PROVIDER',
      'KYC_PROVIDER',
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
      'KYC_PROVIDER',
      'KYC_WEBHOOK_SECRET',
      'ADMIN_LOGIN_MODE',
      'ADMIN_ALLOWED_EMAIL_DOMAINS',
      'ADMIN_WEB_ORIGIN',
      'BITCOIN_NETWORK',
      'CHAIN_RISK_PROVIDER',
    ]);
  });

  it('parses admin settings and their defaults', () => {
    expect(parseEnv(apiEnvSchema, DEV_API_ENV)).toMatchObject({
      ADMIN_ALLOWED_EMAIL_DOMAINS: ['reef.local'],
      ADMIN_IP_ALLOWLIST: ['127.0.0.1/32', '::1/128'],
      ADMIN_SESSION_IDLE_MINUTES: 30,
      ADMIN_SESSION_MAX_HOURS: 12,
    });
  });

  it.each(['10.0.0.0', '10.0.0.0/33', '::1/129', 'host/8', '10.0.0.0/8/1'])(
    'rejects the admin IP allowlist entry %j',
    (entry) => {
      const paths = issuePaths(apiEnvSchema, { ...DEV_API_ENV, ADMIN_IP_ALLOWLIST: entry });

      expect([...new Set(paths.map((path) => path.split('.')[0]))]).toEqual(['ADMIN_IP_ALLOWLIST']);
    },
  );

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
    // These skip the chain or hostname check under some parsers; only verify-full is safe.
    ['DATABASE_URL', 'postgresql://reef:x@db.internal:5432/reef?sslmode=require'],
    ['DATABASE_URL', 'postgresql://reef:x@db.internal:5432/reef?sslmode=verify-ca'],
    [
      'DATABASE_URL',
      'postgresql://reef:x@db.internal:5432/reef?sslmode=require&uselibpqcompat=true',
    ],
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
    ['KYC_PROVIDER', 'dev_stub'],
    ['ADMIN_LOGIN_MODE', 'dev_local'],
    ['ADMIN_OIDC_ISSUER', 'http://sso.example.com'],
    ['ADMIN_WEB_ORIGIN', 'http://admin.example.com'],
    ['ADMIN_IP_ALLOWLIST', '0.0.0.0/0'],
    ['ADMIN_IP_ALLOWLIST', '0.0.0.0/1,128.0.0.0/1'],
    ['ADMIN_IP_ALLOWLIST', '2000::/3'],
    ['KYC_WEBHOOK_SECRET', 'change-me-to-at-least-32-random-characters'],
    ['HIBP_ENABLED', 'false'],
    ['BITCOIN_NETWORK', 'regtest'],
  ])('rejects the dev-only auth setting %s in production', (key, value) => {
    expect(issuePaths(apiEnvSchema, { ...PROD_API_ENV, [key]: value })).toContain(key);
  });

  it('requires TRUST_PROXY_HOPS to be stated in production', () => {
    const unset = Object.fromEntries(
      Object.entries(PROD_API_ENV).filter(([key]) => key !== 'TRUST_PROXY_HOPS'),
    );

    expect(issuePaths(apiEnvSchema, unset)).toContain('TRUST_PROXY_HOPS');
    expect(issuePaths(apiEnvSchema, { ...PROD_API_ENV, TRUST_PROXY_HOPS: '0' })).not.toContain(
      'TRUST_PROXY_HOPS',
    );
  });

  it('accepts signet in production, for staging', () => {
    expect(issuePaths(apiEnvSchema, { ...PROD_API_ENV, BITCOIN_NETWORK: 'signet' })).not.toContain(
      'BITCOIN_NETWORK',
    );
  });

  it('rejects an unknown Bitcoin network', () => {
    expect(issuePaths(apiEnvSchema, { ...DEV_API_ENV, BITCOIN_NETWORK: 'testnet3' })).toEqual([
      'BITCOIN_NETWORK',
    ]);
  });

  it('accepts a VPN-sized admin allowlist in production', () => {
    expect(
      issuePaths(apiEnvSchema, { ...PROD_API_ENV, ADMIN_IP_ALLOWLIST: '10.0.0.0/8,2001:db8::/32' }),
    ).not.toContain('ADMIN_IP_ALLOWLIST');
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
  it('parses the workers env with the default price sources', () => {
    const workers = { ...DEV_API_ENV, API_PORT: undefined };

    expect(parseEnv(workersEnvSchema, workers)).toMatchObject({
      PRICE_SOURCES: ['coinbase', 'kraken', 'bitstamp'],
      PRICE_POLL_INTERVAL_MS: 15_000,
    });
  });

  it.each([
    ['fixed', 'PRICE_SOURCES'],
    ['kraken', 'PRICE_SOURCES'],
  ])('rejects PRICE_SOURCES=%s in production', (sources, path) => {
    const workers = { ...PROD_API_ENV, PRICE_SOURCES: sources };

    expect(issuePaths(workersEnvSchema, workers)).toContain(path);
  });

  it.each(['kraken,kraken', 'kraken,binance', ''])('rejects PRICE_SOURCES=%j', (sources) => {
    const paths = issuePaths(workersEnvSchema, { ...DEV_API_ENV, PRICE_SOURCES: sources });

    expect(paths.map((path) => path.split('.')[0])).toContain('PRICE_SOURCES');
  });

  it('accepts two or more exchanges in production', () => {
    expect(
      issuePaths(workersEnvSchema, { ...PROD_API_ENV, PRICE_SOURCES: 'kraken,coinbase' }),
    ).not.toContain('PRICE_SOURCES');
  });

  it('parses chain screening settings with their defaults', () => {
    expect(parseEnv(workersEnvSchema, { ...DEV_API_ENV, API_PORT: undefined })).toMatchObject({
      CHAIN_RISK_PROVIDER: 'dev_stub',
      TRM_API_URL: 'https://api.trmlabs.com',
      SCREENING_TIMEOUT_MS: 5_000,
      OFAC_MAX_AGE_HOURS: 72,
      OFAC_SDN_URL:
        'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
      OFAC_IMPORT_INTERVAL_HOURS: 24,
    });
  });

  it.each([
    ['CHAIN_RISK_PROVIDER', { CHAIN_RISK_PROVIDER: 'chainalysis' }],
    ['TRM_API_URL', { TRM_API_URL: 'http://api.trmlabs.com' }],
    ['OFAC_SDN_URL', { OFAC_SDN_URL: 'http://www.treasury.gov/ofac/downloads/sdn.xml' }],
    ['OFAC_MAX_AGE_HOURS', { OFAC_MAX_AGE_HOURS: '200' }],
  ])('rejects an invalid %s', (path, extra) => {
    expect(issuePaths(workersEnvSchema, { ...DEV_API_ENV, ...extra })).toContain(path);
  });

  it('rejects a placeholder TRM key in production', () => {
    const env = { ...PROD_API_ENV, TRM_API_KEY: 'change-me-trm-api-key' };

    expect(issuePaths(apiEnvSchema, env)).toContain('TRM_API_KEY');
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
