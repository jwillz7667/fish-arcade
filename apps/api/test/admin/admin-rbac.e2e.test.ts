import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import { adminCall, adminSignIn, createAdmin, type AdminSession } from '../support/admin-flows.js';
import { signUp, type InjectResponse } from '../support/auth-flows.js';

let t: TestApp;
let db: pg.Pool;

beforeAll(async () => {
  t = await buildTestApp();
  db = new pg.Pool({ connectionString: inject('databaseUrls').admin, max: 4 });
});

afterAll(async () => {
  await t.app.close();
  await db.end();
});

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;
const signedIn = async (roles: string[]): Promise<AdminSession> =>
  adminSignIn(t, await createAdmin(db, roles));

async function auditRows(
  actorId: string,
): Promise<{ action: string; before: unknown; after: unknown }[]> {
  const { rows } = await db.query<{ action: string; before: unknown; after: unknown }>(
    `SELECT action, before, after FROM audit_logs WHERE actor_id = $1 AND actor_type = 'admin' ORDER BY id`,
    [actorId],
  );
  return rows;
}

async function placeHold(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO account_holds (user_id, kind, reason, source_type, source_id)
     VALUES ($1, 'redemption', 'kyc_sanctions_pep', 'kyc_check', $2) RETURNING id`,
    [userId, randomUUID()],
  );
  return rows[0]?.id ?? '';
}

describe('permissions (spec §13.1)', () => {
  it('refuses a route its role lacks with 403, and audits the denial', async () => {
    const support = await signedIn(['support_agent']);

    const response = await adminCall(t, support, 'GET', '/v1/admin/jurisdictions');

    expect(response.statusCode).toBe(403);
    expect((await auditRows(support.adminId)).map((row) => row.action)).toContain(
      'admin.permission_denied',
    );
  });

  it('refuses a route that declares no permission, even for a super admin', async () => {
    const superAdmin = await signedIn(['super_admin']);

    const response = await adminCall(t, superAdmin, 'POST', '/v1/admin/test/undeclared');

    expect(response.statusCode).toBe(403);
  });

  it('applies role changes on the next request', async () => {
    const [superAdmin, compliance] = [
      await signedIn(['super_admin']),
      await signedIn(['compliance_officer']),
    ];
    const before = await adminCall(t, compliance, 'GET', '/v1/admin/jurisdictions');

    await adminCall(t, superAdmin, 'PUT', `/v1/admin/admins/${compliance.adminId}/roles`, {
      roles: ['analyst'],
    });
    const after = await adminCall(t, compliance, 'GET', '/v1/admin/jurisdictions');

    expect([before.statusCode, after.statusCode]).toEqual([200, 403]);
  });

  it('caps super admins at two and forbids changing your own roles', async () => {
    await db.query(
      `DELETE FROM admin_user_roles WHERE role_id = (SELECT id FROM roles WHERE name = 'super_admin')`,
    );
    const [first, second] = [await signedIn(['super_admin']), await signedIn(['super_admin'])];
    const candidate = await createAdmin(db, ['analyst']);

    const third = await adminCall(t, first, 'PUT', `/v1/admin/admins/${candidate.adminId}/roles`, {
      roles: ['super_admin'],
    });
    const self = await adminCall(t, second, 'PUT', `/v1/admin/admins/${second.adminId}/roles`, {
      roles: ['analyst'],
    });

    expect([third.statusCode, self.statusCode]).toEqual([409, 403]);
  });
});

describe('audit of admin writes', () => {
  it('records a masked before/after diff of only the changed fields', async () => {
    const ops = await signedIn(['ops_manager']);

    await adminCall(t, ops, 'POST', '/v1/admin/test/write');
    const row = (await auditRows(ops.adminId)).find((entry) => entry.action === 'admin.test.write');

    expect(row?.before).toEqual({ displayName: 'Old', email: '[REDACTED]' });
    expect(row?.after).toEqual({ displayName: 'New', email: '[REDACTED]' });
  });

  it('records every admin write, including ones audited by their service', async () => {
    const compliance = await signedIn(['compliance_officer']);
    const future = new Date(t.auth.clock.now().getTime() + 86_400_000).toISOString();

    await adminCall(t, compliance, 'POST', '/v1/admin/jurisdictions', {
      stateCode: 'NM',
      effectiveFrom: future,
      mode: 'S',
      minAge: 18,
      scRedemptionEnabled: false,
      fishGamesEnabled: true,
      legalMemoRef: 'MEMO-NM-1',
    });
    const hold = await placeHold((await signUp(t)).userId);
    await adminCall(t, compliance, 'POST', '/v1/admin/approvals', {
      action: 'account_hold.release',
      payload: { holdId: hold, reason: 'Cleared after manual review' },
    });

    expect((await auditRows(compliance.adminId)).map((row) => row.action)).toEqual(
      expect.arrayContaining(['compliance.jurisdiction.scheduled', 'admin.approval.requested']),
    );
  });

  it('records failed writes with their error code', async () => {
    const ops = await signedIn(['ops_manager']);

    const response = await adminCall(t, ops, 'POST', '/v1/admin/test/fail');
    const row = (await auditRows(ops.adminId)).find((entry) => entry.action.endsWith('.failed'));

    expect(response.statusCode).toBe(409);
    expect(row).toEqual({
      action: 'admin.TestAdminController.fail.failed',
      before: null,
      after: { error: 'CONFLICT', params: {} },
    });
  });
});

describe('PII masking by role', () => {
  it('masks email and date of birth for support, and shows them to compliance', async () => {
    const player = await signUp(t, `masked-${randomUUID()}@example.com`);
    const [support, compliance] = [
      await signedIn(['support_agent']),
      await signedIn(['compliance_officer']),
    ];

    const masked = (await adminCall(t, support, 'GET', `/v1/admin/players/${player.userId}`)).json<
      Record<string, unknown>
    >();
    const full = (await adminCall(t, compliance, 'GET', `/v1/admin/players/${player.userId}`)).json<
      Record<string, unknown>
    >();

    expect(masked).toMatchObject({
      email: 'm***@e***.com',
      dateOfBirth: '****-**-**',
      isPiiMasked: true,
    });
    expect(full).toMatchObject({
      email: player.email,
      dateOfBirth: '1990-04-02',
      isPiiMasked: false,
    });
  });
});

describe('four-eyes approvals', () => {
  async function requestRelease(
    requester: AdminSession,
  ): Promise<{ approvalId: string; holdId: string }> {
    const holdId = await placeHold((await signUp(t)).userId);
    const response = await adminCall(t, requester, 'POST', '/v1/admin/approvals', {
      action: 'account_hold.release',
      payload: { holdId, reason: 'Cleared after manual review' },
    });
    return { approvalId: response.json<{ id: string }>().id, holdId };
  }

  const releasedAt = async (holdId: string) =>
    (
      await db.query<{ released_at: Date | null }>(
        'SELECT released_at FROM account_holds WHERE id = $1',
        [holdId],
      )
    ).rows[0]?.released_at ?? null;

  it('executes when a second admin with the right role approves', async () => {
    const [requester, approver] = [
      await signedIn(['compliance_officer']),
      await signedIn(['compliance_officer']),
    ];
    const { approvalId, holdId } = await requestRelease(requester);

    const approved = await adminCall(
      t,
      approver,
      'POST',
      `/v1/admin/approvals/${approvalId}/approve`,
    );

    expect(approved.json()).toMatchObject({ status: 'executed', decidedBy: approver.adminId });
    expect(await releasedAt(holdId)).not.toBeNull();
  });

  it('refuses the requester approving their own request', async () => {
    const requester = await signedIn(['compliance_officer']);
    const { approvalId, holdId } = await requestRelease(requester);

    const response = await adminCall(
      t,
      requester,
      'POST',
      `/v1/admin/approvals/${approvalId}/approve`,
    );

    expect(response.statusCode).toBe(403);
    expect(await releasedAt(holdId)).toBeNull();
    expect((await auditRows(requester.adminId)).map((row) => row.action)).toContain(
      'admin.ApprovalsController.approve.failed',
    );
  });

  it('refuses to execute once the requester has lost the request permission', async () => {
    const [requester, approver] = [
      await signedIn(['compliance_officer']),
      await signedIn(['compliance_officer']),
    ];
    const { approvalId, holdId } = await requestRelease(requester);
    await db.query('DELETE FROM admin_user_roles WHERE admin_user_id = $1', [requester.adminId]);

    const response = await adminCall(
      t,
      approver,
      'POST',
      `/v1/admin/approvals/${approvalId}/approve`,
    );

    expect(response.statusCode).toBe(409);
    expect(await releasedAt(holdId)).toBeNull();
  });

  it("refuses an approver without the action's permission", async () => {
    const [requester, finance] = [
      await signedIn(['compliance_officer']),
      await signedIn(['finance']),
    ];
    const { approvalId } = await requestRelease(requester);

    expect(
      (await adminCall(t, finance, 'POST', `/v1/admin/approvals/${approvalId}/approve`)).statusCode,
    ).toBe(403);
  });

  it('cannot execute after 24 hours, and records the expiry', async () => {
    const requester = await signedIn(['compliance_officer']);
    const { approvalId, holdId } = await requestRelease(requester);

    t.auth.clock.advance(24 * 3_600_000 + 1_000);
    // Sessions do not survive a day, so the approver signs in after the jump.
    const approver = await signedIn(['compliance_officer']);
    const response = await adminCall(
      t,
      approver,
      'POST',
      `/v1/admin/approvals/${approvalId}/approve`,
    );

    expect([response.statusCode, errorCode(response)]).toEqual([409, 'CONFLICT']);
    expect(await releasedAt(holdId)).toBeNull();
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM approvals WHERE id = $1',
      [approvalId],
    );
    expect(rows[0]?.status).toBe('expired');
    expect((await auditRows(approver.adminId)).map((row) => row.action)).toContain(
      'admin.approval.expired',
    );
  });

  it('executes once when two approvers race', async () => {
    const [requester, a, b] = [
      await signedIn(['compliance_officer']),
      await signedIn(['compliance_officer']),
      await signedIn(['compliance_officer']),
    ];
    const { approvalId } = await requestRelease(requester);

    const results = await Promise.all([
      adminCall(t, a, 'POST', `/v1/admin/approvals/${approvalId}/approve`),
      adminCall(t, b, 'POST', `/v1/admin/approvals/${approvalId}/approve`),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('lets the requester withdraw a pending request', async () => {
    const requester = await signedIn(['compliance_officer']);
    const { approvalId, holdId } = await requestRelease(requester);

    const withdrawn = await adminCall(
      t,
      requester,
      'POST',
      `/v1/admin/approvals/${approvalId}/reject`,
    );

    expect(withdrawn.json()).toMatchObject({ status: 'rejected' });
    expect(await releasedAt(holdId)).toBeNull();
  });

  it('validates the action and its payload', async () => {
    const requester = await signedIn(['compliance_officer']);

    const unknown = await adminCall(t, requester, 'POST', '/v1/admin/approvals', {
      action: 'money.print',
      payload: {},
    });
    const badPayload = await adminCall(t, requester, 'POST', '/v1/admin/approvals', {
      action: 'account_hold.release',
      payload: { holdId: 'x' },
    });

    expect([unknown.statusCode, badPayload.statusCode]).toEqual([400, 400]);
  });
});
