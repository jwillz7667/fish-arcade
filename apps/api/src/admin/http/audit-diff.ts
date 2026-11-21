import { redactSensitive } from '@reef/logger';

/** Changed fields only, each side masked. */
export interface AuditDiff {
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * Before/after diff for an admin write (playbook Step 9). Only fields that changed are kept,
 * and PII is masked with the logger's redaction rules, so the audit log never becomes a PII
 * store.
 *
 * @param before State before the write, or undefined for a create.
 * @param after State after the write, or undefined for a delete.
 * @returns The masked diff.
 */
export function auditDiff(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>> | undefined,
): AuditDiff {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changedBefore = new Map<string, unknown>();
  const changedAfter = new Map<string, unknown>();
  const beforeEntries = new Map(Object.entries(before ?? {}));
  const afterEntries = new Map(Object.entries(after ?? {}));
  for (const key of keys) {
    const was = beforeEntries.get(key);
    const now = afterEntries.get(key);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    if (beforeEntries.has(key)) changedBefore.set(key, was);
    if (afterEntries.has(key)) changedAfter.set(key, now);
  }
  return {
    before: redactSensitive(Object.fromEntries(changedBefore)),
    after: redactSensitive(Object.fromEntries(changedAfter)),
  };
}
