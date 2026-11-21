# 0002. Location checks as short-lived geo tokens

Status: accepted (playbook Step 7)

## Context

Spec §12 defines `POST /geo/check`, which takes the payload from the vendor's device SDK. Gated actions (signup, purchase, SC play, redemption) then need proof of a recent, allowed check. Vendor checks are slow and metered, so running one inside every gated request is not practical, and the SDK payload is produced once per check on the client.

## Decision

- An allowed check returns a geo token: `g1.<claims>.<HMAC-SHA256>`, signed with `AUTH_HMAC_KEY` under its own purpose label. The claims are the `geo_checks` row ID, the action, the state, the player (or none for signup), the client IP, and an expiry of at most 10 minutes.
- `@RequireJurisdiction(action)` accepts only a token for the same action, player, and IP that has not expired. It then re-reads the state's rule, so a rule change that takes effect after the check still applies.
- The token carries no secrets and is not stored server-side. The `geo_checks` row is the audit trail.

## Consequences

- A player whose IP changes (for example, moving from Wi-Fi to mobile data) must check again. That errs on the side of blocking, which the compliance rules require.
- A token allows the action for up to 10 minutes after the check, which matches spec §15's 10-minute recheck for SC play. A shorter window is a config change (`GEO_TOKEN_TTL_SECONDS`).
- Rotating `AUTH_HMAC_KEY` invalidates outstanding geo tokens, along with CSRF tokens and OTP hashes. Clients just check again.
