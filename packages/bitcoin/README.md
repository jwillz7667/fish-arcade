# @reef/bitcoin

Bitcoin building blocks for the deposit and payout rails (spec §22): address parsing per network, the cold multisig, a BTCPay Greenfield client, webhook verification, and the regtest tooling.

|               |                                     |
| ------------- | ----------------------------------- |
| Spec          | §22                                 |
| Built in      | Step 10 of `docs/BUILD_PLAYBOOK.md` |
| Coverage gate | 80%                                 |

## What's here

| Module                        | Purpose                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network.ts`                  | `BITCOIN_NETWORKS` (`regtest`, `signet`, `mainnet`), address and extended-key version bytes                                                                                                                                                                        |
| `address.ts`                  | `parseAddress(input, network)`. Accepts P2PKH, P2SH, P2WPKH, P2WSH, P2TR. Rejects another network's address with `INVALID_ADDRESS` and names the network it belongs to. Regtest shares testnet's base58 bytes, so only bech32 tells them apart, as in Bitcoin Core |
| `multisig.ts`                 | The 2-of-3 P2WSH cold wallet from three watch-only account keys: the descriptor (with its BIP 380 checksum), NBXplorer's derivation scheme for BTCPay, and local address derivation. Private keys are refused                                                      |
| `btcpay/greenfield-client.ts` | BTCPay Greenfield calls the platform needs. Every response is validated; amounts come back as exact satoshis; failures fail closed                                                                                                                                 |
| `btcpay/webhook.ts`           | `isValidBtcpaySignature` for the `BTCPay-Sig` header (HMAC-SHA256, constant-time), and the event schema. The event body is only a hint: re-fetch the invoice before acting                                                                                         |
| `bitcoind-rpc.ts`             | JSON-RPC client for the regtest tooling and tests. The platform itself never talks to bitcoind                                                                                                                                                                     |

Descriptors and addresses are checked against Bitcoin Core in the unit tests, and the regtest bootstrap re-checks BTCPay, Bitcoin Core, and this package against each other.

## Regtest stack

`docker-compose.btc.yml` runs bitcoind, NBXplorer, BTCPay Server, and its Postgres. All ports bind to 127.0.0.1; settings come from `.env` (see `.env.example`).

| Command                      | Does                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm btc:up`                | Starts the stack and runs the bootstrap. Idempotent                                                                        |
| `pnpm btc:down`              | Stops the stack and keeps its data                                                                                         |
| `pnpm btc:reset`             | Stops the stack, **deletes its volumes**, and deletes `.keys/regtest/`                                                     |
| `pnpm btc:mine <n>`          | Mines n blocks to the dev wallet                                                                                           |
| `pnpm btc:fund <addr> <btc>` | Pays a regtest address from the dev wallet without mining, so the payment starts unconfirmed                               |
| `pnpm test:btc`              | Runs the regtest end-to-end tests: invoice, payment, 0-conf stays unsettled, one block settles it, signed webhook verifies |

The bootstrap (`scripts/bootstrap-regtest.ts`):

1. Refuses to run unless `BITCOIN_NETWORK=regtest` **and** bitcoind reports the regtest chain.
2. Makes three throwaway cosigner keys in `.keys/regtest/cosigners.json` (gitignored, mode 600). Their private halves are never printed and never reach BTCPay.
3. Creates the BTCPay admin, then trades the password for an admin API key at once, since BTCPay accepts passwords on its API only for an account's first five minutes.
4. Creates the store: USD, 1-confirmation settlement, 15-minute invoices, no underpayment tolerance, and a fixed $50,000/BTC rate (regtest has no exchanges).
5. Attaches the watch-only multisig, creates a store-scoped API key, and registers a webhook to the API (`BTCPAY_WEBHOOK_URL`).
6. Writes the store ID, API key, and webhook secret to `.keys/regtest/btcpay.json`.

BTCPay blocks webhooks to private addresses. The compose file allows only `host.docker.internal`, where the API and the test receiver listen, through `BTCPAY_SSRFEXCEPTIONS`. On Linux, run the end-to-end tests with `BTC_TEST_WEBHOOK_BIND=0.0.0.0` so the container can reach the receiver.

## Exchange rate

BTCPay converts USD invoices to BTC with its own rate source. `getOnChainPayment` returns the rate an invoice used (`rate`, integer cents per BTC), which is recorded with the invoice and checked against the oracle with `assertRatesAgree` from `@reef/pricing`. Staging and production stores use `setPreferredRateSource(storeId, 'kraken')`: Kraken is one of the oracle's own sources, so the two agree to well within the 1% guard. The regtest store prices at a fixed $50,000/BTC, and the development oracle's `fixed` source reports the same.

## Production keys

Production keys are made by people, on hardware wallets, following `docs/runbooks/key-ceremony.md`. Nothing in this package generates, stores, or accepts production private keys.
