/**
 * JSON with object keys sorted at every depth, so equal payloads serialise identically no
 * matter how the client ordered their keys.
 *
 * @param value A JSON-compatible value.
 * @returns Canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}
