import { randomUUID } from 'node:crypto';

import { ErrorCode } from '@reef/errors';
import {
  houseAccount,
  playerAccount,
  SC_WINNINGS_KIND,
  splitScBet,
  type AccountRef,
  type JournalInput,
} from '@reef/ledger';
import { units, type Units } from '@reef/money';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { getBalances, postJournal, postScBet } from '../../src/wallet/index.js';

const pool = new pg.Pool({ connectionString: inject('databaseUrls').reef_app, max: 10 });
afterAll(() => pool.end());

const issued = houseAccount('GC_issued');
const promo = houseAccount('SC_promo');
const scResult = houseAccount('game_result', 'SC');

function transfer(
  from: AccountRef,
  to: AccountRef,
  amount: bigint,
  key = randomUUID(),
): JournalInput {
  return {
    type: 'test_transfer',
    idempotencyKey: key,
    createdBy: 'integration-test',
    entries: [
      { account: from, amount: units(-amount) },
      { account: to, amount: units(amount) },
    ],
  };
}

async function balance(account: AccountRef): Promise<Units> {
  return (await getBalances(pool, [account])).get(account.code) ?? units(0n);
}

async function newPlayer(gc = 0n): Promise<{ id: string; gc: AccountRef }> {
  const id = randomUUID();
  const account = playerAccount(id, 'GC');
  if (gc > 0n) await postJournal(pool, transfer(issued, account, gc));
  return { id, gc: account };
}

async function journalCount(key: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM journals WHERE idempotency_key = $1',
    [key],
  );
  return Number(rows[0]?.n);
}

async function ledgerTotals(): Promise<{
  balances: bigint;
  entries: bigint;
  mismatched: bigint;
  negative: bigint;
}> {
  const { rows } = await pool.query<Record<string, string>>(`
    SELECT
      (SELECT coalesce(sum(amount), 0) FROM balances) AS balances,
      (SELECT coalesce(sum(amount), 0) FROM ledger_entries) AS entries,
      (SELECT count(*) FROM balances b
         WHERE b.amount <> (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e WHERE e.account_id = b.account_id)
      ) AS mismatched,
      (SELECT count(*) FROM balances WHERE owner_type IN ('player', 'session') AND amount < 0) AS negative`);
  const row = rows[0] ?? {};
  return {
    balances: BigInt(row['balances'] ?? '0'),
    entries: BigInt(row['entries'] ?? '0'),
    mismatched: BigInt(row['mismatched'] ?? '0'),
    negative: BigInt(row['negative'] ?? '0'),
  };
}

describe('postJournal: success', () => {
  it('posts a GC + SC purchase journal and updates every balance', async () => {
    const userId = randomUUID();
    const gc = playerAccount(userId, 'GC');
    const bonus = playerAccount(userId, 'SC_bonus');

    const posted = await postJournal(pool, {
      type: 'purchase',
      idempotencyKey: `purchase:${randomUUID()}`,
      createdBy: 'system:cashier',
      ref: { type: 'purchase', id: randomUUID() },
      entries: [
        { account: issued, amount: units(-10_000_000n) },
        { account: gc, amount: units(10_000_000n) },
        { account: promo, amount: units(-1_000_000n) },
        { account: bonus, amount: units(1_000_000n) },
      ],
    });
    const balances = await getBalances(pool, [gc, bonus]);

    expect(posted.isReplay).toBe(false);
    expect([balances.get(gc.code), balances.get(bonus.code)]).toEqual([10_000_000n, 1_000_000n]);
  });

  it('applies the SC spend order: bonus first, winnings to redeemable', async () => {
    const userId = randomUUID();
    const bonus = playerAccount(userId, 'SC_bonus');
    const redeemable = playerAccount(userId, 'SC_redeemable');
    await postJournal(pool, transfer(promo, bonus, 30n));
    await postJournal(pool, transfer(promo, redeemable, 50n));

    const split = splitScBet(
      { bonus: await balance(bonus), redeemable: await balance(redeemable) },
      units(50n),
    );
    await postJournal(pool, {
      type: 'sc_bet',
      idempotencyKey: randomUUID(),
      createdBy: 'integration-test',
      entries: [
        { account: bonus, amount: units(0n - split.fromBonus) },
        { account: redeemable, amount: units(0n - split.fromRedeemable) },
        { account: scResult, amount: units(50n) },
      ],
    });
    await postJournal(pool, transfer(scResult, playerAccount(userId, SC_WINNINGS_KIND), 40n));

    expect([await balance(bonus), await balance(redeemable)]).toEqual([0n, 70n]);
  });

  it('reads never-posted accounts as zero', async () => {
    expect(await balance(playerAccount(randomUUID(), 'GC'))).toBe(0n);
  });
});

describe('postJournal: failure', () => {
  it('rejects an overdraft and leaves no trace', async () => {
    const player = await newPlayer(100n);
    const key = randomUUID();

    await expect(postJournal(pool, transfer(player.gc, issued, 101n, key))).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.INSUFFICIENT_FUNDS }),
    );
    expect([await balance(player.gc), await journalCount(key)]).toEqual([100n, 0]);
  });

  it('rejects an unbalanced journal before touching the database', async () => {
    const player = await newPlayer();
    const key = randomUUID();
    const unbalanced: JournalInput = {
      ...transfer(issued, player.gc, 5n, key),
      entries: [
        { account: issued, amount: units(-5n) },
        { account: player.gc, amount: units(4n) },
      ],
    };

    await expect(postJournal(pool, unbalanced)).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }),
    );
    expect(await journalCount(key)).toBe(0);
  });

  it('refuses an account whose stored attributes contradict its code', async () => {
    const player = await newPlayer(1n);
    const forged: AccountRef = { ...player.gc, kind: 'SC_bonus', currency: 'SC' };

    await expect(postJournal(pool, transfer(promo, forged, 1n))).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.INTEGRITY_VIOLATION }),
    );
  });
});

describe('postJournal: database unavailable', () => {
  it('reports an unreachable database as retryable, not as corrupt data', async () => {
    const unreachable = new pg.Pool({
      connectionString: 'postgresql://reef_app@127.0.0.1:1/reef',
      connectionTimeoutMillis: 1_000,
    });

    await expect(
      postJournal(unreachable, transfer(issued, playerAccount(randomUUID(), 'GC'), 1n)),
    ).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    await unreachable.end();
  });
});

describe('postJournal: retry', () => {
  it('replays the same key and payload without moving money twice', async () => {
    const player = await newPlayer();
    const journal = transfer(issued, player.gc, 25n);

    const first = await postJournal(pool, journal);
    const second = await postJournal(pool, { ...journal, entries: [...journal.entries].reverse() });

    expect(second).toEqual({ journalId: first.journalId, isReplay: true });
    expect(await balance(player.gc)).toBe(25n);
  });

  it('rejects the same key with a different payload', async () => {
    const player = await newPlayer();
    const key = randomUUID();
    await postJournal(pool, transfer(issued, player.gc, 25n, key));

    await expect(postJournal(pool, transfer(issued, player.gc, 26n, key))).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_CONFLICT }),
    );
    expect(await balance(player.gc)).toBe(25n);
  });
});

describe('postJournal: concurrency', () => {
  it('posts once when the same key is sent 10 times at once', async () => {
    const player = await newPlayer();
    const journal = transfer(issued, player.gc, 7n);

    const results = await Promise.all(Array.from({ length: 10 }, () => postJournal(pool, journal)));

    expect(new Set(results.map((result) => result.journalId)).size).toBe(1);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect([await balance(player.gc), await journalCount(journal.idempotencyKey)]).toEqual([7n, 1]);
  });

  it('finishes 50 parallel transfers across the same accounts with correct balances', async () => {
    const players = await Promise.all(Array.from({ length: 5 }, () => newPlayer(1_000n)));
    // Each transfer moves 10 units from player i to player (i + 1) mod 5 or back, so lock order
    // conflicts in both directions.
    const transfers = Array.from({ length: 50 }, (_, index) => {
      const from = players[index % 5];
      const to = players[(index + (index % 2 === 0 ? 1 : 4)) % 5];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      return { from, to, journal: transfer(from.gc, to.gc, 10n) };
    });
    const expected = new Map(players.map((player) => [player.gc.code, 1_000n]));
    for (const { from, to } of transfers) {
      expected.set(from.gc.code, (expected.get(from.gc.code) ?? 0n) - 10n);
      expected.set(to.gc.code, (expected.get(to.gc.code) ?? 0n) + 10n);
    }

    await Promise.all(transfers.map(({ journal }) => postJournal(pool, journal)));
    const actual = await getBalances(
      pool,
      players.map((player) => player.gc),
    );

    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
    expect(await ledgerTotals()).toMatchObject({ balances: 0n, mismatched: 0n, negative: 0n });
  });

  it('replays a concurrent retry of a full-balance debit instead of reporting insufficient funds', async () => {
    const player = await newPlayer(100n);
    const debit = transfer(player.gc, issued, 100n);

    const results = await Promise.all([postJournal(pool, debit), postJournal(pool, debit)]);

    expect(new Set(results.map((result) => result.journalId)).size).toBe(1);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect(await balance(player.gc)).toBe(0n);
  });

  it('creates the same new accounts from journals listing them in opposite orders', async () => {
    const pairs = Array.from({ length: 10 }, () => [
      playerAccount(randomUUID(), 'GC'),
      playerAccount(randomUUID(), 'GC'),
    ]);
    const journals = pairs.flatMap(([a, b]) => {
      if (a === undefined || b === undefined) throw new Error('unreachable');
      const grant = (first: AccountRef, second: AccountRef): JournalInput => ({
        type: 'test_grant',
        idempotencyKey: randomUUID(),
        createdBy: 'integration-test',
        entries: [
          { account: issued, amount: units(-2n) },
          { account: first, amount: units(1n) },
          { account: second, amount: units(1n) },
        ],
      });
      return [grant(a, b), grant(b, a)];
    });

    const results = await Promise.allSettled(journals.map((journal) => postJournal(pool, journal)));

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const balances = await getBalances(pool, pairs.flat());
    expect([...balances.values()].every((amount) => amount === 2n)).toBe(true);
  });

  it('never overdraws when parallel debits race for the same balance', async () => {
    const player = await newPlayer(100n);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => postJournal(pool, transfer(player.gc, issued, 10n))),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    expect(await balance(player.gc)).toBe(0n);
  });
});

describe('ledger invariants under random journal sequences (fast-check)', () => {
  it('keeps player balances non-negative, totals at zero, balances equal to entries, and replays idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            from: fc.integer({ min: 0, max: 4 }),
            to: fc.integer({ min: 0, max: 4 }),
            amount: fc.bigInt({ min: 1n, max: 500n }),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (steps) => {
          const players = await Promise.all(Array.from({ length: 4 }, () => newPlayer(200n)));
          const accounts = [issued, ...players.map((player) => player.gc)];
          const journals = steps
            .filter((step) => step.from !== step.to)
            .map((step) =>
              transfer(accounts[step.from] ?? issued, accounts[step.to] ?? issued, step.amount),
            );

          const posted: JournalInput[] = [];
          for (const journal of journals) {
            try {
              await postJournal(pool, journal);
              posted.push(journal);
            } catch (error) {
              expect(error).toMatchObject({ code: ErrorCode.INSUFFICIENT_FUNDS });
            }
          }
          const before = await getBalances(pool, accounts);
          // Only journals that posted are replays; a rejected one retried later is a new attempt.
          const replays = await Promise.all(posted.map((journal) => postJournal(pool, journal)));
          const after = await getBalances(pool, accounts);
          const totals = await ledgerTotals();

          expect(replays.every((result) => result.isReplay)).toBe(true);
          expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
          expect(totals).toMatchObject({ balances: 0n, entries: 0n, mismatched: 0n, negative: 0n });
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('postScBet: spend order under the balance lock (spec §10.2)', () => {
  async function funded(bonus: bigint, redeemable: bigint): Promise<string> {
    const userId = randomUUID();
    if (bonus > 0n)
      await postJournal(pool, transfer(promo, playerAccount(userId, 'SC_bonus'), bonus));
    if (redeemable > 0n) {
      await postJournal(pool, transfer(promo, playerAccount(userId, 'SC_redeemable'), redeemable));
    }
    return userId;
  }

  const bet = (userId: string, amount: bigint, key = randomUUID()) =>
    postScBet(pool, {
      type: 'sc_bet',
      idempotencyKey: key,
      userId,
      bet: units(amount),
      to: scResult,
      createdBy: 'integration-test',
    });

  const scBalances = async (userId: string) => [
    await balance(playerAccount(userId, 'SC_bonus')),
    await balance(playerAccount(userId, 'SC_redeemable')),
  ];

  it('draws bonus first, then redeemable', async () => {
    const userId = await funded(30n, 50n);

    const posted = await bet(userId, 40n);

    expect(posted.split).toEqual({ fromBonus: 30n, fromRedeemable: 10n });
    expect(await scBalances(userId)).toEqual([0n, 40n]);
  });

  it('never draws redeemable SC while bonus remains, however bets race', async () => {
    const userId = await funded(100n, 100n);

    const results = await Promise.all(Array.from({ length: 10 }, () => bet(userId, 15n)));
    const fromBonus = results.reduce((sum, result) => sum + result.split.fromBonus, 0n);

    // 150 wagered: all 100 bonus first, then 50 redeemable. Reading balances outside the lock
    // let racing bets each see the full bonus.
    expect(fromBonus).toBe(100n);
    expect(await scBalances(userId)).toEqual([0n, 50n]);
  });

  it('refuses a bet the SC balances cannot cover and moves nothing', async () => {
    const userId = await funded(5n, 5n);

    await expect(bet(userId, 11n)).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_FUNDS });
    expect(await scBalances(userId)).toEqual([5n, 5n]);
  });

  it('replays with the original split, and refuses the key for a different bet', async () => {
    const userId = await funded(10n, 10n);
    const key = randomUUID();
    const first = await bet(userId, 15n, key);

    const replay = await bet(userId, 15n, key);

    expect(replay).toEqual({ ...first, isReplay: true });
    await expect(bet(userId, 16n, key)).rejects.toMatchObject({
      code: ErrorCode.IDEMPOTENCY_CONFLICT,
    });
    expect(await scBalances(userId)).toEqual([0n, 5n]);
  });

  it('refuses a destination that is not an SC account', async () => {
    const userId = await funded(10n, 0n);

    await expect(
      postScBet(pool, {
        type: 'sc_bet',
        idempotencyKey: randomUUID(),
        userId,
        bet: units(5n),
        to: issued,
        createdBy: 'integration-test',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});
