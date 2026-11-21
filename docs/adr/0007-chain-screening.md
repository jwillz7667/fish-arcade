# 0007. Chain screening

Status: accepted (playbook Step 12)

## Context

Spec §15 and §22 require sanctions and risk screening of every deposit source and every payout address, with an always-on local OFAC check and a vendor (TRM Labs, per ADR 0006). OFAC sanctions are strict liability: crediting or paying a sanctioned party is a violation whatever the intent. The screening path must therefore fail closed, and a stale or poisoned cache must never turn a hit into a pass.

## Decision

- **Two sources, OFAC first.** Every screening checks the local copy of OFAC's SDN list before the vendor. A sanctioned answer from either source is final. Anything else needs both: when either is down, the outcome is `unavailable`.
- **The OFAC list.** apps/workers downloads `SDN.XML` from OFAC's Sanctions List Service daily and extracts every "Digital Currency Address - XBT" entry that parses as a mainnet address. In the November 2026 list that was 534 entries; OFAC had labeled one Tron address as XBT, and the parser rejects it.
  - Each distinct file (by SHA-256) becomes a new version in `ofac_imports`, and only the newest is in force, so delistings take effect.
  - An unchanged file only moves `checked_at`. A list not confirmed within `OFAC_MAX_AGE_HOURS` (72) makes screening `unavailable`.
  - The importer refuses an empty list, a list that lost over half its addresses (a person confirms a real delisting and runs `pnpm ofac:import --accept-shrink`), and an older publication than the one in force.
- **Deposits are screened by their source addresses.** The vendor's address screening covers both ownership and counterparty exposure, so a separate transaction-screening call (`screenTransaction` in the playbook) adds nothing. The source addresses come from our own node; the transaction's combined verdict is recorded under its txid.
- **Sanctioned means ownership.** A TRM entity or ownership indicator in a sanctions category marks the address sanctioned. Counterparty exposure to a sanctioned party keeps TRM's risk level, usually severe, which already freezes a deposit.
- **Cache.** Only low-risk, unsanctioned vendor verdicts are cached, for 24 hours, keyed by vendor and the address's blind index. A read accepts nothing else, so even a poisoned entry cannot pass a risky address. OFAC is checked on every call regardless of the cache.
- **Policy.**

  | Subject        | Outcome                              | Action                                             |
  | -------------- | ------------------------------------ | -------------------------------------------------- |
  | Deposit        | Sanctioned or severe                 | Freeze the account, credit nothing, critical alert |
  | Deposit        | High                                 | Credit GC, hold the SC bonus, review, high alert   |
  | Deposit        | Low or medium                        | Credit normally                                    |
  | Deposit        | Vendor down, sanctions checked clean | Credit GC, hold the SC bonus, screen again         |
  | Deposit        | No sanctions check possible          | Credit nothing yet, screen again                   |
  | Payout address | Sanctioned                           | Reject, freeze the account, critical alert         |
  | Payout address | Severe                               | Reject, high alert                                 |
  | Payout address | Medium or high                       | Manual review, medium alert                        |
  | Payout address | Low                                  | Allow                                              |
  | Payout address | Unavailable                          | Wait; payouts to it wait                           |

  Gold Coins have no cash value, so a clean sanctions check is enough to credit them while the vendor is down. Anything redeemable waits for a full verdict. A severe payout address is rejected outright rather than reviewed (the playbook says review): no reviewer should be able to approve paying a darknet market or a ransomware wallet.

- **Freeze.** A freeze suspends an active account, places a `freeze` hold, opens the AML alert, audits it, and ends every session. Every login path and every refresh refuses an account with an active freeze, whatever its status, so a self-excluded or closed account stays as it is and is blocked all the same. The player gets the same answer as a wrong password, which avoids tipping off a sanctioned party. Compliance lifts it through the four-eyes `account_hold.release` approval; releasing the last freeze hold reactivates a suspended account.
- **Vendors per network.** `dev_stub` (every address clean unless scripted) is refused on mainnet; `trm_labs` is refused anywhere else, since TRM screens mainnet only. Staging on signet therefore runs the stub.

## Consequences

- If TRM or the OFAC import is down, payouts stop and SC bonuses stay pending. The `ofac_import.failed` metric and the screening outcome logs drive alerting.
- TRM's full API reference is behind its customer login. The adapter follows TRM's v2 address-screening API and validates every response strictly; anything unrecognised fails closed. Verifying it against TRM's account documentation is part of signing the contract.
- Steps 13 and 14 call `screenDepositSources`, `screenAddress`, `decideDeposit`, `decidePayoutAddress`, and `AccountFreezer`. Step 14 re-screens a payout address within 24 hours of each payout.
