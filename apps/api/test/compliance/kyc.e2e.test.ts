import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { signWebhook } from '../../src/compliance/kyc/webhook-signature.js';
import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import { post, signUp, type InjectResponse, type MobileSession } from '../support/auth-flows.js';

const SECRET = 'test-kyc-webhook-secret-0123456789abcdef';

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

/** Starts a KYC session and returns the check and its vendor reference. */
async function startKyc(
  session: MobileSession,
  level: 'light' | 'full',
): Promise<{ checkId: string; vendorRef: string; response: InjectResponse }> {
  const response = await post(t, '/v1/kyc/session', { level }, { headers: session.bearer });
  const { checkId } = response.json<{ checkId: string }>();
  const { rows } = await db.query<{ vendor_ref: string }>(
    'SELECT vendor_ref FROM kyc_checks WHERE id = $1',
    [checkId],
  );
  return { checkId, vendorRef: rows[0]?.vendor_ref ?? '', response };
}

function deliver(webhook: { rawBody: string; signature?: string }): Promise<InjectResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/webhooks/kyc',
    headers: {
      'content-type': 'application/json',
      ...(webhook.signature === undefined ? {} : { 'x-reef-kyc-signature': webhook.signature }),
    },
    payload: webhook.rawBody,
  });
}

async function statusOf(checkId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM kyc_checks WHERE id = $1',
    [checkId],
  );
  return rows[0]?.status;
}

const gated = (session: MobileSession, route: 'kyc-light' | 'redemption') =>
  post(t, `/v1/test/${route}`, {}, { headers: session.bearer });

describe('KYC sessions', () => {
  it('start a pending check and return the vendor SDK token, storing only the reference', async () => {
    const session = await signUp(t);

    const { checkId, vendorRef, response } = await startKyc(session, 'light');

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ checkId, sdkToken: expect.any(String) });
    const { rows } = await db.query('SELECT * FROM kyc_checks WHERE id = $1', [checkId]);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      vendor: 'dev_stub',
      vendor_ref: vendorRef,
      reasons: [],
    });
  });

  it('need a signed-in player', async () => {
    expect((await post(t, '/v1/kyc/session', { level: 'light' })).statusCode).toBe(401);
  });
});

describe('KYC webhooks', () => {
  it('apply a passed check, which unlocks light-KYC routes but not redemption', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'light');

    const delivered = await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect(delivered.json()).toEqual({ status: 'applied' });
    expect(await statusOf(checkId)).toBe('passed');
    expect((await gated(session, 'kyc-light')).statusCode).toBe(201);
    expect(errorCode(await gated(session, 'redemption'))).toBe('KYC_REQUIRED');
  });

  it('allow redemption after a full check passes (spec §5.1)', async () => {
    const session = await signUp(t);
    const before = await gated(session, 'redemption');
    const { vendorRef } = await startKyc(session, 'full');

    await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect([before.statusCode, errorCode(before)]).toEqual([403, 'KYC_REQUIRED']);
    expect((await gated(session, 'redemption')).statusCode).toBe(201);
    expect((await gated(session, 'kyc-light')).statusCode).toBe(201);
  });

  it('reject a bad, missing, or malformed signature and change nothing', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'light');
    const webhook = await t.kyc.script(vendorRef, 'passed');

    const wrongSecret = await deliver({
      ...webhook,
      signature: signWebhook(
        'another-secret-another-secret-xx',
        Buffer.from(webhook.rawBody),
        new Date(),
      ),
    });
    const missing = await deliver({ rawBody: webhook.rawBody });
    const malformed = await deliver({ ...webhook, signature: 'v1=abc' });
    const tampered = await deliver({
      ...webhook,
      rawBody: webhook.rawBody.replace('check.updated', 'check.updatez'),
    });

    expect(
      [wrongSecret, missing, malformed, tampered].map((response) => response.statusCode),
    ).toEqual([401, 401, 401, 401]);
    expect(await statusOf(checkId)).toBe('pending');
  });

  it('reject timestamps more than 5 minutes off, either way', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'light');
    const now = t.auth.clock.now().getTime();

    const stale = await deliver(
      await t.kyc.script(vendorRef, 'passed', new Date(now - 6 * 60_000)),
    );
    const future = await deliver(
      await t.kyc.script(vendorRef, 'passed', new Date(now + 6 * 60_000)),
    );
    const withinWindow = await deliver(
      await t.kyc.script(vendorRef, 'passed', new Date(now - 4 * 60_000)),
    );

    expect([stale.statusCode, future.statusCode]).toEqual([401, 401]);
    expect(withinWindow.json()).toEqual({ status: 'applied' });
    expect(await statusOf(checkId)).toBe('passed');
  });

  it('dedupe a replayed event, even when deliveries race', async () => {
    const session = await signUp(t);
    const { vendorRef } = await startKyc(session, 'full');
    const webhook = await t.kyc.script(vendorRef, 'sanctions_hit');

    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(webhook)));
    const replay = await deliver(webhook);

    expect(results.map((response) => response.json<{ status: string }>().status).sort()).toEqual([
      'applied',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(replay.json()).toEqual({ status: 'duplicate' });
    const alerts = await db.query('SELECT 1 FROM aml_alerts WHERE user_id = $1', [session.userId]);
    expect(alerts.rowCount).toBe(1);
  });

  it('re-fetch the verdict from the vendor instead of trusting the delivery', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'light');
    const passedWebhook = await t.kyc.script(vendorRef, 'passed');

    // The vendor changed its verdict before this delivery arrived.
    await t.kyc.script(vendorRef, 'failed');
    await deliver(passedWebhook);

    expect(await statusOf(checkId)).toBe('failed');
  });

  it('ignore events for checks Reef never started', async () => {
    const outsider = await signUp(t);
    const { vendorRef } = await startKyc(outsider, 'light');
    await db.query('DELETE FROM kyc_checks WHERE vendor_ref = $1', [vendorRef]);

    const response = await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect(response.json()).toEqual({ status: 'ignored' });
  });

  it('answer 503 when the vendor cannot confirm the check, so the vendor retries', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_unknown_ref',
      type: 'check.updated',
      data: { reference: 'dev_light_missing' },
    });

    const response = await deliver({
      rawBody,
      signature: signWebhook(SECRET, Buffer.from(rawBody), new Date()),
    });

    expect(response.statusCode).toBe(503);
  });
});

describe('KYC status transitions', () => {
  it('pending → review → passed', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'full');

    await deliver(await t.kyc.script(vendorRef, 'review'));
    const inReview = await statusOf(checkId);
    await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect([inReview, await statusOf(checkId)]).toEqual(['review', 'passed']);
  });

  it('review → failed, and failed is final (failed → passed is rejected and audited)', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'full');
    await deliver(await t.kyc.script(vendorRef, 'review'));
    await deliver(await t.kyc.script(vendorRef, 'failed'));

    const flip = await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect(flip.json()).toEqual({ status: 'rejected' });
    expect(await statusOf(checkId)).toBe('failed');
    const audit = await db.query(
      `SELECT 1 FROM audit_logs WHERE action = 'kyc.transition_rejected' AND target_id = $1`,
      [checkId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('pending → sanctions hit opens a critical AML alert and holds redemption', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'full');

    await deliver(await t.kyc.script(vendorRef, 'sanctions_hit'));

    const alert = await db.query<{ rule: string; severity: string; status: string }>(
      'SELECT rule, severity, status FROM aml_alerts WHERE user_id = $1',
      [session.userId],
    );
    const hold = await db.query<{ kind: string; source_id: string }>(
      'SELECT kind, source_id FROM account_holds WHERE user_id = $1 AND released_at IS NULL',
      [session.userId],
    );
    expect(alert.rows).toEqual([
      { rule: 'kyc_sanctions_pep', severity: 'critical', status: 'open' },
    ]);
    expect(hold.rows).toEqual([{ kind: 'redemption', source_id: checkId }]);
    expect(errorCode(await gated(session, 'redemption'))).toBe('REDEMPTION_SUSPENDED');
  });

  it('passed → sanctions hit on a later list update suspends a fully verified player', async () => {
    const session = await signUp(t);
    const full = await startKyc(session, 'full');
    await deliver(await t.kyc.script(full.vendorRef, 'passed'));
    const allowed = await gated(session, 'redemption');

    await deliver(await t.kyc.script(full.vendorRef, 'sanctions_hit'));

    expect(allowed.statusCode).toBe(201);
    expect(errorCode(await gated(session, 'redemption'))).toBe('REDEMPTION_SUSPENDED');
    expect(errorCode(await gated(session, 'kyc-light'))).toBe('KYC_REQUIRED');
  });

  it('sanctions hit is final', async () => {
    const session = await signUp(t);
    const { checkId, vendorRef } = await startKyc(session, 'light');
    await deliver(await t.kyc.script(vendorRef, 'sanctions_hit'));

    const flip = await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect([flip.json<{ status: string }>().status, await statusOf(checkId)]).toEqual([
      'rejected',
      'sanctions_hit',
    ]);
  });

  it('a repeated verdict changes nothing', async () => {
    const session = await signUp(t);
    const { vendorRef } = await startKyc(session, 'light');
    await deliver(await t.kyc.script(vendorRef, 'passed'));

    const again = await deliver(await t.kyc.script(vendorRef, 'passed'));

    expect(again.json()).toEqual({ status: 'unchanged' });
  });
});
