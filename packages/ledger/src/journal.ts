import { createHash } from 'node:crypto';

import { ValidationError, type ValidationIssue } from '@reef/errors';
import type { Units } from '@reef/money';

import type { AccountRef, Currency } from './accounts.js';

/** One line of a journal: a signed amount on one account. */
export interface JournalEntryInput {
  readonly account: AccountRef;
  /** Coin units. Positive credits the account, negative debits it. Never zero. */
  readonly amount: Units;
}

/** What the journal is about, e.g. `{ type: 'purchase', id }`. */
export interface JournalRef {
  readonly type: string;
  readonly id: string;
}

/** Input to `postJournal` (spec §10.2, playbook Step 4). */
export interface JournalInput {
  /** Journal type, e.g. `purchase`, `session_join`, `checkpoint`. */
  readonly type: string;
  /** Unique per logical operation. Retrying with the same key never moves money twice. */
  readonly idempotencyKey: string;
  readonly entries: readonly JournalEntryInput[];
  readonly ref?: JournalRef;
  /** Actor that caused the journal: a user, admin, or system component ID. */
  readonly createdBy: string;
}

const MAX_KEY_LENGTH = 200;
const MAX_TYPE_LENGTH = 64;

function checkText(value: string, path: string, max: number, issues: ValidationIssue[]): void {
  if (value.length === 0 || value.length > max) {
    issues.push({ path, message: `Must be 1 to ${String(max)} characters` });
  }
}

/**
 * Checks a journal before it touches the database. Spec §10.2: two or more entries that sum
 * to zero. Sums are checked per currency, because GC and SC can share a journal (a purchase
 * grants both) but must each balance on their own.
 *
 * @param input Journal to check.
 * @throws ValidationError listing every problem found.
 */
export function validateJournal(input: JournalInput): void {
  const issues: ValidationIssue[] = [];
  checkText(input.type, 'type', MAX_TYPE_LENGTH, issues);
  checkText(input.idempotencyKey, 'idempotencyKey', MAX_KEY_LENGTH, issues);
  checkText(input.createdBy, 'createdBy', MAX_TYPE_LENGTH * 2, issues);
  if (input.entries.length < 2)
    issues.push({ path: 'entries', message: 'Needs at least two entries' });

  const seen = new Set<string>();
  const sums = new Map<Currency, bigint>();
  input.entries.forEach(({ account, amount }, index) => {
    if (amount === 0n)
      issues.push({ path: `entries.${String(index)}.amount`, message: 'Must not be zero' });
    if (seen.has(account.code)) {
      issues.push({ path: `entries.${String(index)}.account`, message: 'Account appears twice' });
    }
    seen.add(account.code);
    sums.set(account.currency, (sums.get(account.currency) ?? 0n) + amount);
  });
  for (const [currency, sum] of sums) {
    if (sum !== 0n)
      issues.push({ path: 'entries', message: `${currency} entries must sum to zero` });
  }

  if (issues.length > 0) {
    throw new ValidationError({ message: 'Journal is invalid', issues });
  }
}

/**
 * Canonical SHA-256 of a journal's content, stored as `journals.request_hash`. A retry with the
 * same idempotency key must hash identically; entry order does not matter.
 *
 * @param input Journal to hash.
 * @returns Lowercase hex digest.
 */
export function hashJournal(input: JournalInput): string {
  const entries = input.entries
    .map(({ account, amount }) => [account.code, amount.toString()] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const canonical = JSON.stringify({
    type: input.type,
    ref: input.ref === undefined ? null : [input.ref.type, input.ref.id],
    entries,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
