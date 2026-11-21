# 0003. Bitcoin libraries, watch-only BTCPay, and regtest tooling

Status: accepted (playbook Step 10)

## Context

Spec §22 makes Bitcoin the only money rail. Deposits go to BTCPay, which must be watch-only over a 2-of-3 cold multisig. Payouts come later from a signer whose key lives in KMS. Every address the platform reads must be parsed for the configured network. Development needs a full local chain with BTCPay, and the cold keys must never exist on a server or pass through an AI tool.

## Decision

- **Libraries.** Use `@scure/btc-signer` (addresses, scripts, PSBTs later) and `@scure/bip32` (extended keys), pinned exactly. Both are audited, dependency-light (`@noble` curves and hashes), and widely used. Hand-written address or key code is not acceptable for money paths.
- **One package.** `@reef/bitcoin` owns network parameters, `parseAddress`, the multisig descriptor and derivation, the BTCPay Greenfield client, and webhook verification, so the API, workers, and signer share one implementation.
- **Watch-only BTCPay.** BTCPay gets only the three account xpubs, as NBXplorer's `2-of-xpub-xpub-xpub` derivation scheme, which is P2WSH with keys sorted per address. That equals `wsh(sortedmulti(2,...))`. The regtest bootstrap proves that BTCPay, Bitcoin Core, and this package derive the same first address.
- **Exact amounts.** BTCPay's decimal strings are parsed into satoshis with `parseBtc` (no floats). Malformed amounts fail closed as `DependencyUnavailableError`.
- **Webhooks are hints.** `BTCPay-Sig` is verified in constant time, and then the invoice is re-fetched from the API. Nothing in the body is trusted.
- **Regtest tooling.** `docker-compose.btc.yml` pins images by digest. The bootstrap refuses to run unless both the env and the node say regtest. It writes throwaway cosigner keys and BTCPay credentials only to `.keys/regtest/` (gitignored, mode 600) and never prints a private key.
- **SSRF exception.** BTCPay blocks webhooks to private addresses. Development allows exactly `host.docker.internal` through `BTCPAY_SSRFEXCEPTIONS` rather than disabling the protection.
- **Network setting.** `BITCOIN_NETWORK` is validated at startup for the API and workers. Regtest is rejected in production; signet is allowed, because staging runs `NODE_ENV=production`.

## Consequences

- Production cold keys come only from the human ceremony in `docs/runbooks/key-ceremony.md`.
- A Linux runner needs `BTC_TEST_WEBHOOK_BIND=0.0.0.0` so BTCPay can reach the test receiver through the Docker host gateway.
- Regtest uses a fixed $50,000/BTC rate. Real pricing arrives with the price oracle in Step 11.
- BTCPay's Greenfield API rejects passwords after an account's first five minutes, so the bootstrap swaps the password for an admin API key at once. A stale `.keys/regtest/btcpay.json` needs `pnpm btc:reset`.
