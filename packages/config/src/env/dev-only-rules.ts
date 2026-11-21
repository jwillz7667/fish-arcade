const VERIFYING_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * True when a Postgres URL does not require TLS. CLAUDE.md: never disable TLS verification,
 * so plaintext database connections are development-only.
 *
 * @param value A parsed `DATABASE_URL`.
 * @returns True when the URL has no `sslmode` that requires TLS.
 */
export function isPlaintextPostgresUrl(value: unknown): boolean {
  // A malformed URL is already reported by the field schema; do not report it twice or throw.
  if (!URL.canParse(String(value))) return false;
  const sslMode = new URL(String(value)).searchParams.get('sslmode');
  return sslMode === null || !VERIFYING_SSL_MODES.has(sslMode);
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
