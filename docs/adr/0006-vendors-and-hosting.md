# 0006. Vendors and hosting

Status: accepted (decided on the founder's behalf; contracts and API keys are the founder's)

## Context

Spec §15 lists vendor candidates for each compliance control and playbook §1 leaves the chain analytics vendor open. Every vendor sits behind an adapter interface with a development stand-in that production config refuses, so a choice here sets which adapter gets built first, not a lock-in.

## Decision

| Need                           | Vendor                                                | Why                                                                                                   |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Chain risk screening (Step 12) | TRM Labs, plus the OFAC SDN address list kept locally | API-first risk scores for every deposit and payout address. The SDN list is free and always on        |
| KYC, liveness, sanctions/PEP   | Sumsub                                                | ID, liveness, sanctions/PEP, and ongoing monitoring in one contract; widely used in gaming and crypto |
| Geolocation                    | GeoComply                                             | The standard regulators and partners recognize in US gaming and sweepstakes                           |
| Fraud and multi-account        | SEON                                                  | Device, email, and phone signals built for gaming                                                     |
| Email / SMS                    | Amazon SES / Twilio                                   | SES runs in the same AWS account; Twilio is reliable for OTPs                                         |
| Admin SSO (OIDC)               | Google Workspace                                      | OIDC plus enforced 2FA, and company email on the domain                                               |
| Math and RNG certification     | GLI                                                   | The most widely recognized test lab                                                                   |
| Treasury exchange              | Kraken or Coinbase business account                   | Whichever approves a sweepstakes business                                                             |
| Cloud                          | AWS, one US region                                    | See below                                                                                             |

### Hosting stays on AWS in the US

- **Keys.** The hot wallet key must live in a managed HSM that supports secp256k1 and never exports it. AWS KMS does, and so do Google Cloud KMS and Azure Key Vault. Most budget hosts do not.
- **Latency.** Fish tables are real time. Servers in Europe add roughly 80 to 150 ms for US players.
- **Law.** Server location does not change which laws apply: serving US players brings US federal and state law wherever the servers are. Offshore hosting tends to worry vendors, banks, and regulators.
- **Excluded providers.** The Justice Department's 2025 rule on bulk US sensitive personal data (28 CFR part 202) restricts sending it to China, Russia, Iran, North Korea, Cuba, and Venezuela, and to companies under their control. KYC records, liveness biometrics, and precise geolocation are covered data, so cloud providers from those countries are excluded.

## Consequences

- Each vendor needs a contract, which is the founder's part; API keys go into the deployment's secrets store, never into chat or the repo.
- GeoComply and TRM Labs are quote-priced. If either is out of budget, Radar replaces GeoComply and Chainalysis or Elliptic replaces TRM behind the same adapters.
