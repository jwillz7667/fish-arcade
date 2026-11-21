# 0001. Player session tokens

Status: accepted (playbook Step 6)

## Context

Players use a browser app and, later, native apps. The playbook fixes the shape: a 10-minute Ed25519 access JWT, an opaque refresh token rotated on every use with reuse detection, httpOnly cookies for the web, and a CSRF header on every state-changing request. Several details were left open.

## Decision

- **Refresh tokens are server-side state.** Stored as SHA-256 hashes in `refresh_tokens`, grouped by `auth_sessions` (the token family). Rotation locks the token and its session row, so concurrent refreshes of one family run one at a time. A spent token presented again revokes the session.
- **Revocation reaches access tokens within one request.** Revoking a session writes a Redis key that outlives every access token issued before it (10 minutes plus skew). The auth guard checks it on each request, so logout and theft detection take effect at once rather than when the JWT expires.
- **CSRF tokens are derived, not stored.** The token is `HMAC(AUTH_HMAC_KEY, session ID)`, delivered in the login response and a readable `__Host-` cookie. It needs no storage, survives refresh, and a sibling subdomain cannot plant a valid one.
- **One response shape per client type.** Browsers get cookies and never see tokens in a body. Native apps opt in with `X-Reef-Client: mobile`, receive tokens in the body, and authenticate with `Authorization: Bearer`, which browsers never attach on their own, so those requests need no CSRF token.
- **Strict reuse detection, no grace window.** Two refreshes racing with the same token log the session out.

## Consequences

- Web clients must serialise refreshes across tabs (for example with the Web Locks API); otherwise a race between tabs signs the player out. Step 23 owns this.
- Each authenticated request costs one Redis lookup. If Redis is down, authenticated requests fail with 503, consistent with the fail-closed rate limiter.
- Rotating the JWT signing key needs a verifier that accepts the old `kid` for 10 minutes; today only one key is configured.
- Revocation markers live only in Redis (review R1, L8, accepted). If Redis loses its data, or the marker write fails after the database commit, a revoked session's access tokens keep working until they expire: at most 10 minutes. The refresh token is revoked in Postgres, so the session cannot be extended. We accept that window rather than add a database read to every request. Production Redis must persist (AOF, as `docker-compose.services.yml` already sets) and alert on data loss.
