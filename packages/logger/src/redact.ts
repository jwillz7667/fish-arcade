/** Replacement written in place of every redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Words that mark a key as sensitive wherever they appear in it, for example `password`,
 * `refreshToken`, `payoutAddress`, `set-cookie`. CLAUDE.md: never log secrets, tokens,
 * passwords, OTPs, session cookies, or PII.
 */
const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'token',
  'authorization',
  'cookie',
  'otp',
  'secret',
  'apikey',
  'ssn',
  'dob',
  'birth',
  'birthdate',
  'address',
  'email',
  'phone',
  'xpub',
  'xprv',
  'descriptor',
  'seed',
  'mnemonic',
]);

/** Multi-word keys that are sensitive only as a whole, such as `firstName`. */
const SENSITIVE_PHRASES = new Set(['firstname', 'lastname', 'fullname', 'legalname']);

/** Words that, together with a final `url`, mark a connection string with embedded credentials. */
const CONNECTION_WORDS = new Set(['database', 'db', 'postgres', 'redis', 'dsn']);

/** Trailing words that are always sensitive: "any key ending in Secret or Key". */
const SENSITIVE_SUFFIXES = new Set(['secret', 'key']);

/**
 * Trailing words that mark a record identifier. CLAUDE.md: log record IDs, not the data, so
 * `tokenId` or `payoutAddressId` stay readable.
 */
const IDENTIFIER_SUFFIXES = new Set(['id', 'ids']);

const MAX_DEPTH = 12;

function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Decides whether a log field name holds sensitive data.
 *
 * @param key Field name in any case style (camelCase, snake_case, kebab-case, UPPER_CASE).
 * @returns True when the value under `key` must be redacted.
 */
export function isSensitiveKey(key: string): boolean {
  const words = splitWords(key);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SENSITIVE_SUFFIXES.has(last)) return true;
  if (IDENTIFIER_SUFFIXES.has(last)) return false;
  if (last === 'url' && words.some((word) => CONNECTION_WORDS.has(word))) return true;
  return SENSITIVE_PHRASES.has(words.join('')) || words.some((word) => SENSITIVE_WORDS.has(word));
}

function redactError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const output = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };
  const fields = redactEntries(Object.entries(error), seen, depth);
  const cause =
    error.cause === undefined ? {} : { cause: redactValue(error.cause, seen, depth + 1) };
  return { ...output, ...fields, ...cause };
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  // bigint is the money type; JSON.stringify would throw on it.
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (value instanceof Error) return redactError(value, seen, depth);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, seen, depth + 1));
  return redactEntries(Object.entries(value), seen, depth);
}

function redactEntries(
  entries: [string, unknown][],
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(child, seen, depth + 1),
    ]),
  );
}

/**
 * Deep-copies a log payload, replacing every sensitive field with {@link REDACTED}. Also turns
 * bigints into strings, Dates into ISO strings, and Errors into plain objects, and cuts
 * circular references.
 *
 * @param payload Fields to log.
 * @returns A redacted copy that is safe to serialise.
 */
export function redactSensitive(payload: Record<string, unknown>): Record<string, unknown> {
  return redactEntries(Object.entries(payload), new WeakSet<object>(), 0);
}
