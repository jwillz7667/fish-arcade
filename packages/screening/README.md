# @reef/screening

Sanctions and chain-risk screening for deposit sources and payout addresses, shared by `apps/api` and `apps/workers`.

|               |                                     |
| ------------- | ----------------------------------- |
| Spec          | §15, §22                            |
| Built in      | Step 12 of `docs/BUILD_PLAYBOOK.md` |
| Decisions     | ADR 0007                            |
| Coverage gate | 80%                                 |

| Export                                           | Purpose                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `ChainScreener`                                  | `screenAddress` and `screenDepositSources`: OFAC first, then the vendor, with clean vendor verdicts cached for 24 hours |
| `decideDeposit`, `decidePayoutAddress`           | The policy table. Pure; every branch is in ADR 0007                                                                     |
| `parseSdnBitcoinAddresses`                       | Extracts the Bitcoin addresses from OFAC's `SDN.XML`                                                                    |
| `OfacList`                                       | Reads the list in force; unavailable when nothing is imported or the list is not confirmed within `OFAC_MAX_AGE_HOURS`  |
| `TrmLabsProvider`, `DevStubChainRiskProvider`    | Vendors. The stub reports addresses clean unless a verdict or outage is scripted                                        |
| `createChainRiskProvider`, `createChainScreener` | Wiring from env. Refuses the stub on mainnet and TRM off mainnet                                                        |

Screening outcomes are `screened` (with a verdict) or `unavailable`. Callers fail closed on `unavailable`: see the policy table.

## Settings

| Variable               | Default                   | Notes                                                |
| ---------------------- | ------------------------- | ---------------------------------------------------- |
| `CHAIN_RISK_PROVIDER`  | none                      | `dev_stub` (regtest, signet) or `trm_labs` (mainnet) |
| `TRM_API_KEY`          | none                      | Required with `trm_labs`                             |
| `TRM_API_URL`          | `https://api.trmlabs.com` | HTTPS only                                           |
| `SCREENING_TIMEOUT_MS` | `5000`                    | Per vendor call                                      |
| `OFAC_MAX_AGE_HOURS`   | `72`                      | Screening fails closed past this                     |

## Test

```
pnpm test                 # policy branches, the SDN parser against test/fixtures/sdn-sample.xml, cache, vendors
pnpm test:integration     # OFAC import and lookup against Postgres (apps/workers/test)
```
