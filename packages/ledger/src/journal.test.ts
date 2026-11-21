import { ErrorCode, type ValidationError } from '@reef/errors';
import { units } from '@reef/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { houseAccount, playerAccount } from './accounts.js';
import { hashJournal, validateJournal, type JournalInput } from './journal.js';

const USER = '0192f1c4-5b6a-7c8d-9e0f-1a2b3c4d5e6f';
const gc = playerAccount(USER, 'GC');
const scBonus = playerAccount(USER, 'SC_bonus');
const issued = houseAccount('GC_issued');
const promo = houseAccount('SC_promo');

const purchase: JournalInput = {
  type: 'purchase',
  idempotencyKey: 'purchase:1',
  createdBy: 'system:cashier',
  ref: { type: 'purchase', id: '1' },
  entries: [
    { account: issued, amount: units(-10_000_000n) },
    { account: gc, amount: units(10_000_000n) },
    { account: promo, amount: units(-1_000_000n) },
    { account: scBonus, amount: units(1_000_000n) },
  ],
};

function issuesOf(input: JournalInput): string[] {
  try {
    validateJournal(input);
    return [];
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    return (error as ValidationError).issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
}

describe('validateJournal', () => {
  it('accepts a two-currency journal that balances per currency', () => {
    expect(issuesOf(purchase)).toEqual([]);
  });

  it('rejects a journal that balances overall but not per currency', () => {
    const crossCurrency: JournalInput = {
      ...purchase,
      entries: [
        { account: issued, amount: units(-5n) },
        { account: scBonus, amount: units(5n) },
      ],
    };

    expect(issuesOf(crossCurrency)).toEqual([
      'entries: GC entries must sum to zero',
      'entries: SC entries must sum to zero',
    ]);
  });

  it('rejects fewer than two entries, zero amounts, and repeated accounts', () => {
    expect(issuesOf({ ...purchase, entries: [{ account: gc, amount: units(0n) }] })).toEqual([
      'entries: Needs at least two entries',
      'entries.0.amount: Must not be zero',
    ]);
    expect(
      issuesOf({
        ...purchase,
        entries: [
          { account: gc, amount: units(1n) },
          { account: gc, amount: units(-1n) },
        ],
      }),
    ).toEqual(['entries.1.account: Account appears twice']);
  });

  it('rejects empty and oversized identifiers', () => {
    expect(
      issuesOf({ ...purchase, type: '', idempotencyKey: 'k'.repeat(201), createdBy: '' }),
    ).toEqual([
      'type: Must be 1 to 64 characters',
      'idempotencyKey: Must be 1 to 200 characters',
      'createdBy: Must be 1 to 128 characters',
    ]);
  });

  it('accepts any random journal whose entries sum to zero', () => {
    const accounts = [
      gc,
      issued,
      houseAccount('game_result', 'GC'),
      playerAccount(USER.replace('6f', '70'), 'GC'),
    ];
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 3 }),
        (credits) => {
          const total = credits.reduce((sum, value) => sum + value, 0n);
          const entries = [
            { account: issued, amount: units(-total) },
            ...credits.map((amount, index) => ({
              account: accounts[(index % 3) + 1] ?? gc,
              amount: units(amount),
            })),
          ].filter(
            (entry, index, all) =>
              all.findIndex((other) => other.account.code === entry.account.code) === index,
          );
          const sum = entries.reduce((acc, entry) => acc + entry.amount, 0n);
          return sum !== 0n || issuesOf({ ...purchase, entries }).length === 0;
        },
      ),
    );
  });
});

describe('hashJournal', () => {
  it('ignores entry order', () => {
    const reversed = { ...purchase, entries: [...purchase.entries].reverse() };

    expect(hashJournal(reversed)).toBe(hashJournal(purchase));
  });

  it('changes when any amount, account, type, or ref changes', () => {
    const withoutRef: JournalInput = {
      type: purchase.type,
      idempotencyKey: purchase.idempotencyKey,
      createdBy: purchase.createdBy,
      entries: purchase.entries,
    };
    const variants: JournalInput[] = [
      { ...purchase, type: 'refund' },
      { ...purchase, ref: { type: 'purchase', id: '2' } },
      withoutRef,
      {
        ...purchase,
        entries: purchase.entries.map((entry, index) =>
          index === 0 ? { ...entry, amount: units(entry.amount - 1n) } : entry,
        ),
      },
    ];

    expect(new Set([purchase, ...variants].map(hashJournal)).size).toBe(5);
  });

  it('ignores the idempotency key and actor', () => {
    expect(hashJournal({ ...purchase, idempotencyKey: 'other', createdBy: 'other' })).toBe(
      hashJournal(purchase),
    );
  });
});
