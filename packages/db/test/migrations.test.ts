import { describe, expect, it } from 'vitest';

import { withClient } from './connect.js';

describe('migrations on an empty database', () => {
  it('applies every migration', async () => {
    const applied = await withClient('reef_migrator', async (client) => {
      const { rows } = await client.query<{ migration_name: string; finished: boolean }>(
        'SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name',
      );
      return rows;
    });

    expect(applied.map((row) => [row.migration_name.slice(15), row.finished])).toEqual([
      ['init', true],
      ['ledger_invariants', true],
      ['role_grants', true],
      ['player_auth', true],
      ['kyc_webhooks_and_holds', true],
      ['admin_auth', true],
      ['admin_oidc_subject', true],
      ['kyc_sanctions_clearance', true],
      ['ledger_hardening', true],
      ['price_snapshot_per_minute', true],
      ['chain_screening', true],
    ]);
  });

  it('creates every table from spec §11 and §22.5', async () => {
    const tables = await withClient('reef_app', async (client) => {
      const { rows } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
      );
      return rows.map((row) => row.table_name);
    });

    expect(tables.sort()).toEqual(
      [
        'users',
        'profiles',
        'devices',
        'user_devices',
        'kyc_checks',
        'geo_checks',
        'jurisdictions',
        'ledger_accounts',
        'journals',
        'ledger_entries',
        'balances',
        'packages',
        'purchases',
        'redemptions',
        'amoe_requests',
        'promotions',
        'bonus_grants',
        'games',
        'math_configs',
        'game_versions',
        'rooms',
        'table_sessions',
        'round_archive_index',
        'jackpots',
        'jackpot_wins',
        'affiliates',
        'referrals',
        'commissions',
        'admin_users',
        'roles',
        'admin_user_roles',
        'approvals',
        'audit_logs',
        'rg_limits',
        'exclusions',
        'aml_alerts',
        'rules_versions',
        'consents',
        'support_tickets',
        'btc_invoices',
        'btc_deposits',
        'payout_addresses',
        'payouts',
        'payout_batches',
        'price_snapshots',
        'chain_screenings',
        'ofac_addresses',
        'ofac_imports',
        'treasury_events',
        'system_flags',
        'otp_challenges',
        'auth_sessions',
        'refresh_tokens',
        'user_mfa',
        'recovery_codes',
        'passkeys',
        'processed_webhooks',
        'account_holds',
        'admin_mfa',
        'admin_sessions',
      ].sort(),
    );
  });

  it.each([
    'otp_challenges',
    'auth_sessions',
    'refresh_tokens',
    'user_mfa',
    'recovery_codes',
    'passkeys',
  ])(
    'grants reef_app read and write on the auth table %s through default privileges',
    async (table) => {
      const privileges = await withClient('reef_app', async (client) => {
        const { rows } = await client.query<{ privilege: string }>(
          `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
            WHERE grantee = 'reef_app' AND table_name = $1`,
          [table],
        );
        return rows.map((row) => row.privilege).sort();
      });

      expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    },
  );

  it('keeps migration history away from reef_app', async () => {
    const code = await withClient('reef_app', (client) =>
      client.query('SELECT 1 FROM _prisma_migrations').then(
        () => undefined,
        (error: unknown) => (error as { code?: string }).code,
      ),
    );

    expect(code).toBe('42501');
  });

  it('keeps processed webhook records append-only for reef_app', async () => {
    const code = await withClient('reef_app', async (client) => {
      await client.query(
        "INSERT INTO processed_webhooks (provider, event_id) VALUES ('test', 'evt-append-only')",
      );
      return client.query("DELETE FROM processed_webhooks WHERE event_id = 'evt-append-only'").then(
        () => undefined,
        (error: unknown) => (error as { code?: string }).code,
      );
    });

    expect(code).toBe('42501');
  });
});
