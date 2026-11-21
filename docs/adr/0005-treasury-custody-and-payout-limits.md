# 0005. Treasury, custody, and payout limits

Status: accepted (decided on the founder's behalf; values are launch values, reviewed monthly)

## Context

Spec §21 item 3 and playbook §1 leave four Bitcoin decisions to the founder: who holds the cold keys, how often deposited BTC is converted to USD, the signer limits, and who pays payout network fees. The founder is the only keyholder and asked the build to choose the rest. Player prizes are USD liabilities (1 SC = $1 prize value) paid in BTC at the send-time rate, so every BTC the company holds beyond its working float is exchange-rate risk against those liabilities.

## Decision

### Cold keys: one keyholder, four places

2-of-3 P2WSH multisig per `docs/runbooks/key-ceremony.md`, on three devices from three manufacturers: Coldcard Q (key 1), Trezor Safe 5 (key 2), Blockstream Jade Plus (key 3). All three support BIP 48 multisig in Sparrow.

| Place                                           | Holds                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| Home safe                                       | Devices 1 and 2, PIN-locked. No seed words           |
| Bank safe deposit box                           | Metal backup of seed 1, printed wallet descriptor    |
| Second bank's box, or the attorney's vault      | Metal backup of seed 2, printed wallet descriptor    |
| Relative's safe, in a sealed tamper-evident bag | Device 3, metal backup of seed 3, printed descriptor |

- No place holds two seeds, so no single place can spend.
- Losing any one place loses nothing. After a fire at home, seeds 1 and 2 recover the wallet.
- The descriptor (all three xpubs) is stored with every backup. Two seeds cannot rebuild a 2-of-3 wallet without the third xpub.
- The two home devices let the founder sign hot wallet refills and weekly sweeps without traveling. The risk this accepts is coercion at home. It is bounded by the weekly conversion below, which keeps cold storage near the float, and by the Coldcard's trick PINs.
- A sealed continuity letter with the company's attorney lists the places and the recovery procedure (never seed words). Without it, prizes are unrecoverable if the founder is incapacitated.
- Upgrade path: when volume grows, move key 3 to a collaborative custody service so a second party can co-sign recovery.

### Treasury conversion: weekly, to a float

- **Float target:** 14 days of trailing payouts plus the hot wallet cap, across hot and cold.
- **Every Monday:** sweep cold BTC above the target to a business exchange account and sell it for USD.
- **Buy back:** when the float falls below 7 days of payouts, buy BTC with USD.
- **Coverage:** BTC at the oracle rate plus USD cash is at least 110% of outstanding redeemable SC at all times. The daily reconciliation (Step 16) reports coverage and alerts below 110%.

### Signer limits (launch values)

Enforced inside `apps/signer` (Step 15). No API call, admin action, or database value can raise them.

| Limit                 | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| Per payout            | $2,000                                                        |
| Per address per day   | $5,000                                                        |
| All payouts per day   | $10,000                                                       |
| Hot wallet cap        | $10,000. Above it: alert and request a sweep to cold          |
| Refill trigger        | Below $3,000 or one day of expected payouts, whichever higher |
| Network fee per batch | At most $50 and 150 sat/vB                                    |

- Worst-case loss with everything upstream compromised is the hot wallet cap: $10,000.
- Redemptions over $2,000 go to a manual large-prize queue: reviewed, then paid from cold storage with two devices. They never touch the hot wallet.
- Limits are reviewed monthly and raised by changing signer config and deploying, when daily payouts regularly reach half the daily cap.

### Network fees: the platform pays

Players receive the full prize value. Deducting fees could read as charging a player to claim a prize, which sweepstakes rules forbid. Payouts batch every 30 minutes and signal RBF. A batch whose fee would exceed the cap waits, and alerts after 2 hours.

Minimum redemption: $50 (spec §5 example) until counsel confirms it.

## Consequences

- The founder signs a refill every few days and a sweep every week. Both happen at home with devices 1 and 2.
- Large winners wait for manual review and a cold-storage signature.
- Needs a business exchange account (apply to Kraken and Coinbase, as both may restrict gaming businesses) and a bank account for the USD.
- Steps 14 to 16 implement the limits, the large-prize queue, the refill and sweep requests, and the coverage report from this ADR.
