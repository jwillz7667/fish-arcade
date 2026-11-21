import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AccountFreezer, type FreezeRequest } from '../../src/compliance/index.js';
import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import { adminCall, adminSignIn, createAdmin } from '../support/admin-flows.js';
import {
  MOBILE,
  post,
  signUp,
  type InjectResponse,
  type MobileSession,
} from '../support/auth-flows.js';

let t: TestApp;
let db: pg.Pool;
let freezer: AccountFreezer;

beforeAll(async () => {
  t = await buildTestApp();
  db = new pg.Pool({ connectionString: inject('databaseUrls').admin, max: 4 });
  freezer = t.app.get(AccountFreezer);
});

afterAll(async () => {
  await t.app.close();
  await db.end();
});

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;
const whoAmI = (session: MobileSession) =>
  t.app.inject({ method: 'GET', url: '/v1/auth/session', headers: session.bearer });
const refresh = (session: MobileSession) =>
  post(t, '/v1/auth/refresh', { refreshToken: session.refreshToken }, { headers: MOBILE });
const login = (account: { email: string; password: string }) =>
  post(
    t,
    '/v1/auth/login',
    { identifier: account.email, password: account.password },
    { headers: MOBILE },
  );

const request = (userId: string, sourceId: string = randomUUID()): FreezeRequest => ({
  userId,
  alert: { rule: 'chain_screening.deposit_sanctioned', severity: 'critical' },
  sourceType: 'btc_deposit',
  sourceId,
});

async function state(userId: string) {
  const [user, holds, alerts] = await Promise.all([
    db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [userId]),
    db.query<{ kind: string; reason: string }>(
      'SELECT kind, reason FROM account_holds WHERE user_id = $1 AND released_at IS NULL',
      [userId],
    ),
    db.query<{ rule: string; severity: string }>(
      'SELECT rule, severity FROM aml_alerts WHERE user_id = $1',
      [userId],
    ),
  ]);
  return { status: user.rows[0]?.status, holds: holds.rows, alerts: alerts.rows };
}

describe('AccountFreezer (playbook Step 12)', () => {
  it('suspends the account, holds it, opens a critical alert, and audits it', async () => {
    const player = await signUp(t);

    const result = await freezer.freeze(request(player.userId));

    expect(result.isNew).toBe(true);
    expect(await state(player.userId)).toEqual({
      status: 'suspended',
      holds: [{ kind: 'freeze', reason: 'chain_screening.deposit_sanctioned' }],
      alerts: [{ rule: 'chain_screening.deposit_sanctioned', severity: 'critical' }],
    });
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action IN ('compliance.account_frozen', 'auth.session.revoked_all')`,
      [player.userId],
    );
    expect(rows.map((row) => row.action).sort()).toEqual([
      'auth.session.revoked_all',
      'compliance.account_frozen',
    ]);
  });

  it('cuts off live access tokens, refreshes, and new logins', async () => {
    const player = await signUp(t);
    expect((await whoAmI(player)).statusCode).toBe(200);

    await freezer.freeze(request(player.userId));

    const [session, refreshed, loggedIn] = [
      await whoAmI(player),
      await refresh(player),
      await login(player),
    ];
    expect(session.statusCode).toBe(401);
    expect(refreshed.statusCode).toBe(401);
    // The same answer as a wrong password: a frozen party learns nothing.
    expect([loggedIn.statusCode, errorCode(loggedIn)]).toEqual([401, 'INVALID_CREDENTIALS']);
  });

  it('freezes once per source, even when called concurrently', async () => {
    const player = await signUp(t);
    const sourceId = randomUUID();

    const results = await Promise.all([
      freezer.freeze(request(player.userId, sourceId)),
      freezer.freeze(request(player.userId, sourceId)),
    ]);

    expect(results.map((result) => result.isNew).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.holdId)).size).toBe(1);
    expect((await state(player.userId)).alerts).toHaveLength(1);
  });

  it('keeps a self-excluded account self-excluded, and blocks it all the same', async () => {
    const player = await signUp(t);
    await db.query(`UPDATE users SET status = 'self_excluded' WHERE id = $1`, [player.userId]);

    await freezer.freeze(request(player.userId));

    expect((await state(player.userId)).status).toBe('self_excluded');
    expect((await login(player)).statusCode).toBe(401);
  });

  it('reactivates the account only when Compliance releases the last freeze hold', async () => {
    const player = await signUp(t);
    const [first, second] = [
      await freezer.freeze(request(player.userId)),
      await freezer.freeze(request(player.userId)),
    ];
    const [requester, approver] = [
      adminSignIn(t, await createAdmin(db, ['compliance_officer'])),
      adminSignIn(t, await createAdmin(db, ['compliance_officer'])),
    ];
    const release = async (holdId: string) => {
      const asked = await adminCall(t, await requester, 'POST', '/v1/admin/approvals', {
        action: 'account_hold.release',
        payload: { holdId, reason: 'False positive: vendor attribution corrected' },
      });
      return adminCall(
        t,
        await approver,
        'POST',
        `/v1/admin/approvals/${asked.json<{ id: string }>().id}/approve`,
      );
    };

    await release(first.holdId);
    const afterOne = await state(player.userId);
    await release(second.holdId);

    expect(afterOne.status).toBe('suspended');
    expect((await state(player.userId)).status).toBe('active');
    expect((await login(player)).statusCode).toBe(200);
  });
});
