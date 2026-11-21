# @reef/api

NestJS API: auth, accounts, lobby, cashier, promotions, compliance, admin API, and the wallet/ledger module.

|          |                                                  |
| -------- | ------------------------------------------------ |
| Spec     | §5, §8.2, §10, §12, §13, §15, §22                |
| Built in | Steps 4 to 9, 13, 14 of `docs/BUILD_PLAYBOOK.md` |

So far only the wallet module exists. It is framework-free; Step 5 adds the NestJS app and wires the wallet in as a module.

## Wallet (`src/wallet`, spec §10)

The only code that writes ledger tables. Lint enforces this: outside `src/wallet`, `test/wallet`, and `packages/db`, it is an error to name a ledger table in SQL, to touch `prisma.ledgerEntry` and the other ledger delegates, or to deep-import wallet internals.

`postJournal(pool, journal)` runs as one transaction:

1. Validate. Zero-sum is checked per currency; the database checks it again at commit.
2. If the idempotency key exists with the same payload hash (compared with `timingSafeEqual`), return the existing journal with `isReplay: true`. If it exists with a different payload, throw `ConflictError(IDEMPOTENCY_CONFLICT)`.
3. Create any missing accounts and balance rows, and verify that existing ones match the reference.
4. `SELECT … FOR UPDATE` the affected balances in ascending account ID order, so concurrent journals queue instead of deadlocking.
5. Reject any change that would make a player or session balance negative (`InsufficientFundsError`).
6. Insert the journal and its entries, then update the balances.

If a concurrent call with the same key commits first, the unique-index violation is answered as a replay.

`getBalances(pool, accounts)` reads current balances, with zero for accounts never posted to.

## Test

```sh
TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm test:integration
```

The integration tests cover success, failure, retry, and concurrency: the same key sent 10 times at once, 50 parallel transfers in both directions, and 20 racing debits against one balance. fast-check generates random journal sequences and checks the invariants against the real database: player balances are never negative, all balances sum to zero, each balance equals the sum of its entries, and replays are idempotent.
