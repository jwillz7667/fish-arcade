import { DependencyUnavailableError, ValidationError } from '@reef/errors';

import type { Queryable } from '../audit/audit-writer.js';

/** Spec §5.1: the documents every player accepts at signup. */
export const SIGNUP_DOCUMENTS = ['terms', 'official_rules', 'privacy'] as const;

/** One of {@link SIGNUP_DOCUMENTS}. */
export type SignupDocument = (typeof SIGNUP_DOCUMENTS)[number];

/** A published version of a legal document. */
export interface LegalDocumentVersion {
  readonly id: string;
  readonly docType: string;
  readonly version: string;
  readonly url: string;
  readonly effectiveAt: Date;
}

/**
 * The version of each signup document in force at `at`.
 *
 * @param client Pool or transaction client.
 * @param at Point in time.
 * @returns One row per document type that has a version in force.
 */
export async function currentSignupDocuments(
  client: Queryable,
  at: Date,
): Promise<LegalDocumentVersion[]> {
  // rules_versions holds a handful of rows per document type, so this scan stays tiny; the
  // (doc_type, version) unique index covers the doc_type filter.
  const { rows } = await client.query<{
    id: string;
    doc_type: string;
    version: string;
    url: string;
    effective_at: Date;
  }>(
    `SELECT DISTINCT ON (doc_type) id, doc_type, version, url, effective_at
       FROM rules_versions
      WHERE doc_type = ANY($1::text[]) AND effective_at <= $2
      ORDER BY doc_type, effective_at DESC`,
    [[...SIGNUP_DOCUMENTS], at],
  );
  return rows.map((row) => ({
    id: row.id,
    docType: row.doc_type,
    version: row.version,
    url: row.url,
    effectiveAt: row.effective_at,
  }));
}

/**
 * Checks that the player accepted exactly the signup documents in force.
 *
 * @param client Pool or transaction client.
 * @param input The version IDs the client showed and the player accepted, and the time.
 * @returns The IDs of the documents in force.
 * @throws ValidationError when the accepted IDs are not exactly the versions in force (the
 *   player saw an outdated or incomplete set and must reload).
 * @throws DependencyUnavailableError when a signup document has no version in force: signup
 *   fails closed rather than creating an account with no accepted rules.
 */
export async function assertCurrentDocumentsAccepted(
  client: Queryable,
  input: { acceptedIds: readonly string[]; at: Date },
): Promise<string[]> {
  const current = await currentSignupDocuments(client, input.at);
  if (current.length !== SIGNUP_DOCUMENTS.length) {
    throw new DependencyUnavailableError({
      dependency: 'rules_versions',
      message: 'A signup document has no version in force',
    });
  }
  const accepted = new Set(input.acceptedIds);
  if (accepted.size !== current.length || current.some((doc) => !accepted.has(doc.id))) {
    throw new ValidationError({
      issues: [
        {
          path: 'acceptedDocumentIds',
          message: 'must list exactly the current terms, official rules, and privacy policy',
        },
      ],
    });
  }
  return current.map((doc) => doc.id);
}

/**
 * Records that a new player accepted the current terms, official rules, and privacy policy
 * (spec §5.1: the version, the time, and the IP). Runs inside the account-creation
 * transaction, so an account never exists without its consents. Checks again there, in case a
 * new version took effect since the caller's pre-check.
 *
 * @param client Transaction client.
 * @param input The new account, the accepted version IDs, the IP, and the time.
 * @throws ValidationError or DependencyUnavailableError as for
 *   {@link assertCurrentDocumentsAccepted}.
 */
export async function recordSignupConsents(
  client: Queryable,
  input: { userId: string; acceptedIds: readonly string[]; ip: string; at: Date },
): Promise<void> {
  const ids = await assertCurrentDocumentsAccepted(client, input);
  await client.query(
    `INSERT INTO consents (user_id, rules_version_id, accepted_at, ip)
     SELECT $1, unnest($2::uuid[]), $3, $4::inet`,
    [input.userId, ids, input.at, input.ip],
  );
}
