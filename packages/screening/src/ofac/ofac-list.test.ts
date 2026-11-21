import { ErrorCode } from '@reef/errors';
import type { QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Queryable } from '../queryable.js';
import { OfacList } from './ofac-list.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const HOUR = 3_600_000;

function list(rows: object[] | Error) {
  const db = {
    query: () =>
      rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve({ rows, rowCount: rows.length } as unknown as QueryResult),
  } as unknown as Queryable;
  return new OfacList({ db, now: () => NOW, maxAgeMs: 72 * HOUR });
}

const fresh = new Date(NOW.getTime() - HOUR);

describe('OfacList.listed', () => {
  it('returns the addresses on the current list', async () => {
    const ofac = list([
      {
        list_version: '2026-11-20-abc',
        checked_at: fresh,
        address: '12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h',
      },
    ]);

    expect(await ofac.listed(['12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h', 'bc1qclean'])).toEqual(
      new Set(['12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h']),
    );
  });

  it('returns nothing when no address matches', async () => {
    expect(
      await list([{ list_version: 'v', checked_at: fresh, address: null }]).listed(['bc1qclean']),
    ).toEqual(new Set());
  });

  it.each([
    ['nothing was ever imported', []],
    [
      'the list was last confirmed over 72 hours ago',
      [{ list_version: 'v', checked_at: new Date(NOW.getTime() - 73 * HOUR), address: null }],
    ],
    ['the database fails', new Error('ECONNREFUSED')],
  ])('is unavailable when %s', async (_label, rows) => {
    await expect(list(rows).listed(['bc1qclean'])).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });
});
