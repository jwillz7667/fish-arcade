# @reef/money

Branded `bigint` money types, conversions with the spec's rounding rules, strict parsers, and display formatters. No `number` appears in any amount in the public API.

|               |                                             |
| ------------- | ------------------------------------------- |
| Spec          | §10.1, §22.1, §22.3                         |
| Built in      | Step 2 of `docs/BUILD_PLAYBOOK.md`          |
| Coverage gate | 100% branches, lines, functions, statements |

## Types

| Type          | Meaning                                                      | Constructor rejects |
| ------------- | ------------------------------------------------------------ | ------------------- |
| `Units`       | Coin base units, 1 coin = 1,000,000. Signed (ledger entries) | nothing             |
| `Cents`       | US cents                                                     | negatives           |
| `Sats`        | Satoshis                                                     | negatives           |
| `CentsPerBtc` | Integer cents per 1 BTC                                      | zero and negatives  |

## Conversions

| Function               | Rounding | Why                              |
| ---------------------- | -------- | -------------------------------- |
| `unitsToCents`         | down     | §10.1 redemption rounds down     |
| `centsToUnits`         | exact    |                                  |
| `centsToSatsForPayout` | down     | BTC paid to a player rounds down |
| `centsToSatsOwed`      | up       | BTC owed by a player rounds up   |
| `satsToCents`          | down     |                                  |

Property tests (fast-check) prove payout conversions never exceed the exact value, owed conversions never fall below it, and every result is within one unit of exact.

## Parsing and display

`parseCoins("12.5")` and `parseUsd("19.99")` accept plain non-negative decimals only: no signs, separators, symbols, or exponents. `formatCoins` rounds down (toward negative infinity). `formatUsd`, `formatRate`, and `formatBtc` are exact. All formatting is en-US for now. Spanish (§17) comes with the shell's i18n.

## Test

```sh
pnpm vitest run --coverage --project money
```
