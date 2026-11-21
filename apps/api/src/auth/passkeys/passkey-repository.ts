import type { Queryable } from '../../audit/audit-writer.js';

/** A stored WebAuthn credential. */
export interface PasskeyRecord {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly signCount: number;
  readonly transports: readonly string[];
}

/** A verified credential, ready to store. */
export interface NewPasskey {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly deviceType: string;
  readonly isBackedUp: boolean;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  sign_count: string;
  transports: string[] | null;
}

/** Unique constraint hit when a credential is registered twice. */
export const PASSKEY_UNIQUE_CONSTRAINTS = ['passkeys_credential_id_key'];

/** SQL for `passkeys`. Every value is a bound parameter. */
export const passkeyRepository = {
  async insert(client: Queryable, userId: string, passkey: NewPasskey): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO passkeys
         (user_id, credential_id, public_key, sign_count, transports, device_type, is_backed_up)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        userId,
        passkey.credentialId,
        Buffer.from(passkey.publicKey),
        passkey.signCount,
        passkey.transports,
        passkey.deviceType,
        passkey.isBackedUp,
      ],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },

  async findByCredentialId(
    client: Queryable,
    credentialId: string,
  ): Promise<PasskeyRecord | undefined> {
    const { rows } = await client.query<PasskeyRow>(
      `SELECT id, user_id, credential_id, public_key, sign_count, transports
         FROM passkeys WHERE credential_id = $1`,
      [credentialId],
    );
    const [row] = rows;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      credentialId: row.credential_id,
      publicKey: new Uint8Array(row.public_key),
      // WebAuthn sign counters are 32-bit, so they fit a JS number exactly.
      signCount: Number.parseInt(row.sign_count, 10),
      transports: row.transports ?? [],
    };
  },

  async listCredentialIds(client: Queryable, userId: string): Promise<string[]> {
    const { rows } = await client.query<{ credential_id: string }>(
      'SELECT credential_id FROM passkeys WHERE user_id = $1',
      [userId],
    );
    return rows.map((row) => row.credential_id);
  },

  /**
   * Stores the new signature counter. The condition rejects a counter that went backwards,
   * the sign of a cloned authenticator; authenticators that never count stay at zero.
   *
   * @returns True when the counter was accepted.
   */
  async recordUse(
    client: Queryable,
    input: { id: string; signCount: number; at: Date },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE passkeys SET sign_count = $2, last_used_at = $3
        WHERE id = $1 AND (sign_count < $2 OR (sign_count = 0 AND $2 = 0))`,
      [input.id, input.signCount, input.at],
    );
    return result.rowCount === 1;
  },
};
