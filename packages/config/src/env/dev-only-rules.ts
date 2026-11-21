/**
 * True when a Postgres URL does not fully verify the server's certificate. CLAUDE.md: never
 * disable TLS verification. Only `sslmode=verify-full` checks both the chain and the hostname
 * under every parser: `require` and `verify-ca` skip one or both checks with
 * `uselibpqcompat=true` today, and under libpq semantics in the next major of `pg`.
 *
 * @param value A parsed `DATABASE_URL`.
 * @returns True unless the URL sets `sslmode=verify-full`.
 */
export function isPlaintextPostgresUrl(value: unknown): boolean {
  // A malformed URL is already reported by the field schema; do not report it twice or throw.
  if (!URL.canParse(String(value))) return false;
  return new URL(String(value)).searchParams.get('sslmode') !== 'verify-full';
}

/** Fragments that mark a value copied from `.env.example` or a dev setup. */
const PLACEHOLDER_MARKERS = ['change-me', 'placeholder', 'example', 'dev-'];

/**
 * True when a secret still looks like a placeholder, such as the `.env.example` value.
 *
 * @param value A parsed secret.
 * @returns True for a value containing a placeholder marker.
 */
export function isPlaceholderSecret(value: unknown): boolean {
  const text = String(value).toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => text.includes(marker));
}

/**
 * True when a Redis URL uses the plaintext `redis:` scheme instead of `rediss:`.
 *
 * @param value A parsed `REDIS_URL`.
 * @returns True for a non-TLS Redis URL.
 */
export function isPlaintextRedisUrl(value: unknown): boolean {
  return URL.canParse(String(value)) && new URL(String(value)).protocol === 'redis:';
}
