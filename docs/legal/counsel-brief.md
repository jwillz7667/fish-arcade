# Brief for counsel

What Reef needs from outside counsel before real-money (Mode P) launch. Hand this, `docs/spec.md` §4, §15, and §22, and ADRs 0005 and 0006 to a lawyer who practices sweepstakes and gaming law and has advised crypto or fintech clients.

## The business in one paragraph

Reef is an online fish arcade with slots and keno, run as a promotional sweepstakes. Players buy Gold Coins (play-only, never redeemable) with Bitcoin. Sweeps Coins come free, as a bonus with purchases or through a free mail-in or daily online entry, and can be redeemed for prizes valued at $1 per coin. Prizes are paid in Bitcoin from company funds, converted at the send-time rate. The game math is chance-based by design. Every player is identity-verified and geolocated, and every deposit and payout address is screened for sanctions and risk.

## Questions, in priority order

1. **Which states can we serve, and in which mode?** Social only (S), sweepstakes (P), or blocked (X). Spec §4.3 lists the states we already treat as blocked. Is that list right and complete today? May fish games run as sweepstakes anywhere, given the enforcement attention they draw? Our fallback is social mode everywhere permitted and sweepstakes state by state.
2. **Money transmission.** Do any of these make the company a money transmitter, federally (FinCEN) or in any state we would serve?
   - Accepting Bitcoin as payment for Gold Coins. We hold no player BTC balances and never return BTC except as a prize.
   - Paying sweepstakes prizes in Bitcoin from company funds, valued in USD.
   - Converting the company's own BTC to USD weekly through an exchange.
3. **Entity and home state.** Which entity, and where, given items 1 and 2.
4. **Sweepstakes terms.** The Sweeps Coins bonus ratio on packages, the free-entry amount and mail-in rules, and the minimum redemption (currently $50). Spec §5 notes that a 1:1 dollar-to-SC bonus draws legislative criticism.
5. **Published documents.** Terms of service, privacy policy, official rules, and responsible gaming pages. We will build the pages; we need the text.
6. **Biometrics and privacy.** Liveness checks collect biometric data through the KYC vendor. What consent, retention, and deletion terms do Illinois BIPA and similar state laws require?
7. **Tax reporting.** Prize reporting to players (1099 thresholds), and how Bitcoin prizes are valued for it. An accountant may answer this better.
8. **Vendor exposure.** Spec §4.2 notes that states now pursue vendors that support sweepstakes casinos. Do our contracts with KYC, geolocation, screening, and payment vendors need terms for that?

## Already decided by design (tell us if any of these is a problem)

- Sweeps Coins are never sold. Purchases buy Gold Coins only.
- No purchase is necessary. The free entry gives Sweeps Coins on comparable terms.
- The games are not marketed as skill-based.
- Players pay no network fees to receive a prize.
- KYC before the first redemption, geolocation checks on every sensitive action, and sanctions screening on every deposit and payout address.
- Only the compliance role can change which states are allowed, and every change is audited and scheduled at least an hour ahead.
