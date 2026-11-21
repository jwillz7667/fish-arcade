import { describe, expect, it } from 'vitest';

import { PERMISSIONS, permissionsFor } from './admin-permissions.js';
import { buildAllowlist, isIpAllowed } from './http/admin.guard.js';
import { auditDiff } from './http/audit-diff.js';
import { MASKED_DATE, maskEmail, maskPhone } from './players/pii-mask.js';

describe('role permissions (spec §13.1)', () => {
  it('gives super admin everything, including role management', () => {
    expect([...permissionsFor(['super_admin'])].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('lets support see players but not their PII', () => {
    const support = permissionsFor(['support_agent']);

    expect([
      support.has('players.read'),
      support.has('players.read_pii'),
      support.has('balances.adjust_sc'),
    ]).toEqual([true, false, false]);
  });

  it('splits SC adjustments between compliance and finance, and keeps jurisdictions with compliance', () => {
    const [compliance, finance] = [
      permissionsFor(['compliance_officer']),
      permissionsFor(['finance']),
    ];

    expect([compliance.has('balances.adjust_sc'), finance.has('balances.adjust_sc')]).toEqual([
      true,
      true,
    ]);
    expect([compliance.has('jurisdictions.write'), finance.has('jurisdictions.write')]).toEqual([
      true,
      false,
    ]);
  });

  it('unions multiple roles and ignores unknown ones', () => {
    expect([...permissionsFor(['analyst', 'game_ops', 'root'])].sort()).toEqual([
      'games.write',
      'reports.read',
    ]);
    expect(permissionsFor(['root']).size).toBe(0);
  });
});

describe('PII masking', () => {
  it('masks emails, phones, and dates of birth', () => {
    expect([
      maskEmail('jane.doe@example.com'),
      maskEmail('x@localhost'),
      maskPhone('+15551234567'),
      MASKED_DATE,
    ]).toEqual(['j***@e***.com', 'x***@l***', '+*******4567', '****-**-**']);
  });
});

describe('auditDiff', () => {
  it('keeps only changed fields and masks PII', () => {
    expect(
      auditDiff(
        { name: 'A', email: 'a@x.com', status: 'active' },
        { name: 'B', email: 'b@x.com', status: 'active' },
      ),
    ).toEqual({
      before: { name: 'A', email: '[REDACTED]' },
      after: { name: 'B', email: '[REDACTED]' },
    });
  });

  it('handles creates and deletes', () => {
    expect(auditDiff(undefined, { roles: ['analyst'] })).toEqual({
      before: {},
      after: { roles: ['analyst'] },
    });
    expect(auditDiff({ roles: ['analyst'] }, undefined)).toEqual({
      before: { roles: ['analyst'] },
      after: {},
    });
  });
});

describe('admin IP allowlist', () => {
  const allowlist = buildAllowlist(['10.0.0.0/8', '192.0.2.0/28', '2001:db8::/32']);

  it('matches IPv4, IPv4-mapped IPv6, and IPv6 ranges', () => {
    expect(
      ['10.1.2.3', '::ffff:10.9.9.9', '192.0.2.15', '2001:db8::1'].map((ip) =>
        isIpAllowed(allowlist, ip),
      ),
    ).toEqual([true, true, true, true]);
  });

  it('refuses everything else', () => {
    expect(
      ['11.0.0.1', '192.0.2.16', '::ffff:11.0.0.1', '2001:db9::1'].map((ip) =>
        isIpAllowed(allowlist, ip),
      ),
    ).toEqual([false, false, false, false]);
  });
});
