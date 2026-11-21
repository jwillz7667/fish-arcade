import { describe, expect, it } from 'vitest';

import {
  addEntry,
  commitError,
  createAccount,
  createJournal,
  statementError,
  withClient,
} from './connect.js';

const UNBALANCED = { code: '23514', constraint: 'journal_balanced' };
const PERMISSION_DENIED = '42501';

describe('zero-sum journals (spec §10.2)', () => {
  it('commits a balanced journal', async () => {
    const failure = await withClient('reef_app', async (client) => {
      const house = await createAccount(client, 'house');
      const player = await createAccount(client, 'player');
      return commitError(client, async () => {
        const journal = await createJournal(client);
        await addEntry(client, journal, house, -500n);
        await addEntry(client, journal, player, 500n);
      });
    });

    expect(failure).toBeUndefined();
  });

  it('rejects an unbalanced journal at commit, not at insert', async () => {
    const failure = await withClient('reef_app', async (client) => {
      const house = await createAccount(client, 'house');
      const player = await createAccount(client, 'player');
      return commitError(client, async () => {
        const journal = await createJournal(client);
        await addEntry(client, journal, house, -500n);
        await addEntry(client, journal, player, 499n);
      });
    });

    expect(failure).toEqual(UNBALANCED);
  });

  it('rejects a journal that balances overall but not per currency', async () => {
    const failure = await withClient('reef_app', async (client) => {
      const gc = await createAccount(client, 'player', 'GC');
      const sc = await createAccount(client, 'house', 'SC');
      return commitError(client, async () => {
        const journal = await createJournal(client);
        await addEntry(client, journal, gc, 5n);
        await addEntry(client, journal, sc, -5n);
      });
    });

    expect(failure).toEqual(UNBALANCED);
  });

  it('rejects a journal with a single entry or none', async () => {
    const failures = await withClient('reef_app', async (client) => {
      const house = await createAccount(client, 'house');
      const single = await commitError(client, async () => {
        await addEntry(client, await createJournal(client), house, 1n);
      });
      const empty = await commitError(client, async () => {
        await createJournal(client);
      });
      return [single, empty];
    });

    expect(failures).toEqual([UNBALANCED, UNBALANCED]);
  });

  it('rejects entries that unbalance a journal committed earlier', async () => {
    const failure = await withClient('reef_app', async (client) => {
      const house = await createAccount(client, 'house');
      const player = await createAccount(client, 'player');
      let journal = '';
      await commitError(client, async () => {
        journal = await createJournal(client);
        await addEntry(client, journal, house, -1n);
        await addEntry(client, journal, player, 1n);
      });
      return commitError(client, () => addEntry(client, journal, player, 1n));
    });

    expect(failure).toEqual(UNBALANCED);
  });

  it('rejects zero-amount entries', async () => {
    const code = await withClient('reef_app', async (client) => {
      const house = await createAccount(client, 'house');
      await client.query('BEGIN');
      const journal = await createJournal(client);
      const result = await statementError(
        client,
        'INSERT INTO ledger_entries (journal_id, account_id, amount) VALUES ($1, $2, 0)',
        [journal, house],
      );
      await client.query('ROLLBACK');
      return result;
    });

    expect(code).toBe('23514');
  });
});

describe('append-only tables', () => {
  it.each([
    ['UPDATE ledger_entries SET amount = amount'],
    ['DELETE FROM ledger_entries'],
    ['UPDATE journals SET type = type'],
    ['DELETE FROM journals'],
    ['UPDATE audit_logs SET action = action'],
    ['DELETE FROM audit_logs'],
    ['TRUNCATE ledger_entries'],
    ['UPDATE ledger_accounts SET owner_type = owner_type'],
    ['DELETE FROM ledger_accounts'],
    ['DELETE FROM balances'],
    ['TRUNCATE balances'],
  ])('reef_app cannot run: %s', async (sql) => {
    expect(await withClient('reef_app', (client) => statementError(client, sql))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('blocks UPDATE and DELETE even for the owning migrator role', async () => {
    const codes = await withClient('reef_migrator', async (client) => {
      await client.query(
        "INSERT INTO audit_logs (actor_type, action) VALUES ('system', 'integration-test')",
      );
      return [
        await statementError(client, 'UPDATE audit_logs SET action = $1', ['rewritten']),
        await statementError(client, 'DELETE FROM audit_logs'),
        await statementError(client, 'TRUNCATE audit_logs'),
      ];
    });

    expect(codes).toEqual([PERMISSION_DENIED, PERMISSION_DENIED, PERMISSION_DENIED]);
  });

  it('keeps ledger accounts immutable and balance rows undeletable even for the migrator', async () => {
    const codes = await withClient('reef_migrator', async (client) => {
      const account = await createAccount(client, 'player');
      return [
        await statementError(
          client,
          "UPDATE ledger_accounts SET owner_type = 'house', owner_id = NULL WHERE id = $1",
          [account],
        ),
        await statementError(client, 'DELETE FROM balances WHERE account_id = $1', [account]),
      ];
    });

    expect(codes).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
  });

  it('still lets reef_app append audit rows', async () => {
    const code = await withClient('reef_app', (client) =>
      statementError(client, "INSERT INTO audit_logs (actor_type, action) VALUES ('system', 'ok')"),
    );

    expect(code).toBeUndefined();
  });
});

describe('balances', () => {
  it.each(['player', 'session'] as const)('rejects a negative %s balance', async (ownerType) => {
    const code = await withClient('reef_app', async (client) => {
      const account = await createAccount(client, ownerType);
      return statementError(client, 'UPDATE balances SET amount = -1 WHERE account_id = $1', [
        account,
      ]);
    });

    expect(code).toBe('23514');
  });

  it.each(['house', 'jackpot', 'redemption'] as const)(
    'allows a negative %s balance',
    async (ownerType) => {
      const code = await withClient('reef_app', async (client) => {
        const account = await createAccount(client, ownerType);
        return statementError(client, 'UPDATE balances SET amount = -1 WHERE account_id = $1', [
          account,
        ]);
      });

      expect(code).toBeUndefined();
    },
  );

  it('cannot mislabel a player balance as house to dodge the check', async () => {
    const code = await withClient('reef_app', async (client) => {
      const account = await createAccount(client, 'player');
      return statementError(
        client,
        "UPDATE balances SET owner_type = 'house' WHERE account_id = $1",
        [account],
      );
    });

    expect(code).toBe('23503');
  });

  it('requires an owner for player accounts and none for house accounts', async () => {
    const codes = await withClient('reef_app', async (client) => [
      await statementError(
        client,
        "INSERT INTO ledger_accounts (code, owner_type, currency, kind) VALUES ('player:none:GC', 'player', 'GC', 'GC')",
      ),
      await statementError(
        client,
        "INSERT INTO ledger_accounts (code, owner_type, owner_id, currency, kind) VALUES ('house:x', 'house', gen_random_uuid(), 'GC', 'GC_issued')",
      ),
    ]);

    expect(codes).toEqual(['23514', '23514']);
  });
});

describe('roles', () => {
  it('reef_readonly can read but not write', async () => {
    const codes = await withClient('reef_readonly', async (client) => [
      await statementError(client, 'SELECT count(*) FROM ledger_entries'),
      await statementError(
        client,
        "INSERT INTO system_flags (key, value, updated_by) VALUES ('x', 'true', 'ro')",
      ),
    ]);

    expect(codes).toEqual([undefined, PERMISSION_DENIED]);
  });

  it('reef_app cannot change the schema', async () => {
    const code = await withClient('reef_app', (client) =>
      statementError(client, 'CREATE TABLE sneaky (id int)'),
    );

    expect(code).toBe(PERMISSION_DENIED);
  });
});
