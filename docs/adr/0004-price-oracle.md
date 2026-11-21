# 0004. BTC/USD price oracle

Status: accepted (playbook Step 11)

## Context

Spec §22.1 prices packages in USD and pays redemptions in BTC at the oracle rate. A wrong or stale rate moves money, so the rate must come from several exchanges, and everything that needs it must fail closed when it cannot be trusted. BTCPay converts USD invoices with its own rate source, which the platform does not control.

## Decision

- **Sources.** Coinbase, Kraken, and Bitstamp public tickers. None needs a key. They agree to within a few hundredths of a percent in normal markets.
- **Rule.** The price is the median of quotes under 60 seconds old. With fewer than two such quotes, or a spread over 1% of the median, the price is unusable. These limits are constants in `@reef/pricing`, not settings.
- **Where it runs.** The oracle runs in `apps/workers` and publishes each decision to Redis with a 120-second expiry. Readers refuse a published price over 45 seconds old, so a dead oracle pauses purchases and payouts rather than freezing an old rate.
- **Exact values.** Rates are integer cents per BTC, parsed from each exchange's decimal string. Digits past the cent are dropped.
- **Snapshots.** One per minute in `price_snapshots`. `taken_at` is unique, so a second oracle instance cannot double-store a minute.
- **Alerting.** A transition to unusable logs `metric: "price_oracle.paused"` at error level. Log-based alarms (Step 30) page on it.
- **BTCPay.** Of the oracle's three sources, BTCPay supports only Kraken, so the store uses it as its preferred rate source. Every invoice's rate is read back from BTCPay, recorded, and refused if it differs from the oracle by more than 1%. We did not push the oracle's rate into BTCPay's store config every 15 seconds, because that would give the workers write access to store settings.
- **Development.** `PRICE_SOURCES=fixed` runs two fixed stand-ins at the regtest store's $50,000. There are two so that the two-source rule still runs. Production config refuses `fixed` and any list of fewer than two exchanges.

## Consequences

- An outage at two of the three exchanges, or a real 1% dislocation between them, pauses purchases and payouts until it clears. That is intended.
- Purchases (Step 13) and payouts (Step 14+) must call `PriceReader.getRate()` and `assertRatesAgree`; neither may cache a rate.
