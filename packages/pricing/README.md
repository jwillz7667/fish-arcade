# @reef/pricing

The BTC/USD price rules shared by the oracle (`apps/workers`) and everything that prices in bitcoin (purchases, payouts).

|               |                                     |
| ------------- | ----------------------------------- |
| Spec          | §22.1                               |
| Built in      | Step 11 of `docs/BUILD_PLAYBOOK.md` |
| Coverage gate | 80%                                 |

| Export                  | Purpose                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregateQuotes`       | Median of quotes under 60 seconds old. Unusable with fewer than two, or a spread over 1% of the median. Pure                                                                                       |
| `serializeDecision`     | The JSON the oracle publishes under `PRICE_KEY`                                                                                                                                                    |
| `PriceReader.getRate()` | The current rate in integer cents per BTC. Throws `DependencyUnavailableError` (`price_oracle`) when nothing is published, the oracle paused, the value is malformed, or it is over 45 seconds old |
| `assertRatesAgree`      | Refuses a BTCPay invoice rate more than 1% from the oracle's                                                                                                                                       |

The spec's limits (two sources, 60 seconds, 1%) are constants here, not settings.
