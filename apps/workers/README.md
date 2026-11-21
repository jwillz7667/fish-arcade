# @reef/workers

Background processes: the BTC/USD price oracle and the OFAC import now, and later payment and KYC webhooks, payouts, ledger checkpoints, jackpot settlement, screening, email/SMS, and reports.

|          |                                              |
| -------- | -------------------------------------------- |
| Spec     | §8.2, §22                                    |
| Built in | Steps 11, 12, 16 of `docs/BUILD_PLAYBOOK.md` |

## Price oracle (`src/price-oracle`, Step 11, spec §22.1)

Every `PRICE_POLL_INTERVAL_MS` (15 seconds by default) the oracle:

1. Polls every source in `PRICE_SOURCES` at once. Each source has a 5-second timeout, and a failure only drops that source for the round.
2. Keeps the latest quote per source and decides with `@reef/pricing`'s `aggregateQuotes`. The price is the median of quotes under 60 seconds old. It is unusable with fewer than two such quotes, or when they spread more than 1% of the median.
3. Publishes the decision to Redis under `price:v1:btc_usd` with a 120-second expiry. The API reads it with `PriceReader.getRate()`, which also refuses a price over 45 seconds old, so a stopped oracle fails closed.
4. Stores one snapshot per minute in `price_snapshots`. `taken_at` is the minute and is unique, so two oracles never store the same minute twice.
5. Logs `metric: "price_oracle.paused"` at error level when the price becomes unusable, and `price_oracle.resumed` when it recovers. Alerting watches the paused metric: purchases and payouts are failing closed until it clears.

| Setting                     | Default                    | Notes                                                                            |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `PRICE_SOURCES`             | `coinbase,kraken,bitstamp` | Production needs at least two exchanges. `fixed` is development only             |
| `PRICE_FIXED_CENTS_PER_BTC` | none                       | Required with `fixed`. Use `5000000` ($50,000) to match the regtest BTCPay store |
| `PRICE_POLL_INTERVAL_MS`    | `15000`                    | 5,000 to 60,000                                                                  |

Exchange prices are parsed from their decimal strings straight into integer cents per BTC (`parseCentsPerBtc`). Digits past the cent are dropped.

## OFAC import (`src/ofac`, Step 12, ADR 0007)

Every `OFAC_IMPORT_INTERVAL_HOURS` (24 by default) the job downloads OFAC's `SDN.XML` from `OFAC_SDN_URL`, extracts the Bitcoin addresses, and imports them as a new version when the file changed. An unchanged file only confirms the version in force. A failed run logs `metric: "ofac_import.failed"` at error level and keeps the current list; three days without a confirmed list make screening fail closed.

The importer refuses an empty list, a list that lost over half its addresses, and an older publication than the one in force. When OFAC really did delist that many, confirm it on OFAC's recent actions page and run:

```
pnpm --filter @reef/workers ofac:import -- --accept-shrink
```

## Run

```
pnpm --filter @reef/workers dev    # against .env and the local services
```

## Test

```
pnpm test                 # unit: oracle rounds with mocked sources, exchange parsing
pnpm test:integration     # Redis publish, getRate round trip, one snapshot per minute
```
