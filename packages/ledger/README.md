# @reef/ledger

Pure double-entry helpers: account naming, journal validation, payload hashing, and the SC spend order. No I/O; the wallet module in `apps/api` does the posting.

|               |                                             |
| ------------- | ------------------------------------------- |
| Spec          | §10.2, §10.3                                |
| Built in      | Step 4 of `docs/BUILD_PLAYBOOK.md`          |
| Coverage gate | 100% branches, lines, functions, statements |

## Accounts

| Helper                                                         | Code                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `playerAccount(userId, 'GC' \| 'SC_bonus' \| 'SC_redeemable')` | `player:{id}:{kind}`                                                      |
| `sessionAccount(sessionId, currency)`                          | `session:{id}:{currency}`                                                 |
| `houseAccount('GC_issued' \| 'SC_promo')`                      | `house:GC_issued`, `house:SC_promo`                                       |
| `houseAccount('game_result', currency)`                        | `house:game_result:{currency}` (split so GC and SC never share a balance) |
| `jackpotAccount({ id, tier }, currency)`                       | `jackpot:{tier}:{currency}`                                               |
| `redemptionAccount('pending' \| 'paid')`                       | `redemption:pending`, `redemption:paid`                                   |

IDs must be lowercase UUIDs. `isPlayerOwned` is true for player and session accounts; those can never go negative.

## Journals

`validateJournal` requires:

- two or more entries;
- non-zero amounts;
- no account appearing twice;
- a zero sum **per currency** (a purchase journal carries both GC and SC, and each must balance on its own).

`hashJournal` is a canonical SHA-256 that ignores entry order, the idempotency key, and the actor. The wallet stores it to tell a replay from a key reused for a different journal.

## SC spend order

`splitScBet(balances, bet)` draws from `SC_bonus` first, then `SC_redeemable`, and throws `InsufficientFundsError` when both together fall short. Winnings always go to `SC_WINNINGS_KIND` (`SC_redeemable`). Property tests prove the split covers the bet exactly, never overdraws, and never touches redeemable while bonus remains. CLAUDE.md: changes to this logic need human sign-off.

## Test

```sh
pnpm vitest run --coverage --project ledger
```
