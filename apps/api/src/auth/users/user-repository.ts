import type { Queryable } from '../../audit/audit-writer.js';
import type { ContactChannel } from './contact.js';

/** The fields login needs. */
export interface LoginUser {
  readonly id: string;
  readonly passwordHash: string | null;
  readonly status: 'active' | 'suspended' | 'closed' | 'self_excluded';
}

/** A new player account. Encrypted values are @reef/crypto-fields envelopes. */
export interface NewPlayer {
  readonly id: string;
  readonly channel: ContactChannel;
  readonly contactEnc: string;
  readonly contactBidx: string;
  readonly passwordHash: string | null;
  readonly displayName: string;
  readonly dobEnc: string;
  readonly stateCode: string;
}

/** Unique constraints that mean "this email or phone already has an account". */
export const CONTACT_UNIQUE_CONSTRAINTS = ['users_email_bidx_key', 'users_phone_bidx_key'];

// Column names are chosen from a closed union, never from input.
const columnsFor = (channel: ContactChannel): { enc: string; bidx: string } =>
  channel === 'email'
    ? { enc: 'email_enc', bidx: 'email_bidx' }
    : { enc: 'phone_enc', bidx: 'phone_bidx' };

/** SQL for `users` and `profiles`. Every value is a bound parameter. */
export const userRepository = {
  /**
   * @param client Pool or transaction client.
   * @param channel Which contact the blind index is for.
   * @param bidx Blind index of the normalized email or phone.
   * @returns The account's ID, password hash, and status, or undefined.
   */
  async findByContact(
    client: Queryable,
    channel: ContactChannel,
    bidx: string,
  ): Promise<LoginUser | undefined> {
    const sql =
      channel === 'email'
        ? 'SELECT id, password_hash, status FROM users WHERE email_bidx = $1'
        : 'SELECT id, password_hash, status FROM users WHERE phone_bidx = $1';
    const { rows } = await client.query<{
      id: string;
      password_hash: string | null;
      status: LoginUser['status'];
    }>(sql, [bidx]);
    const [row] = rows;
    return row === undefined
      ? undefined
      : { id: row.id, passwordHash: row.password_hash, status: row.status };
  },

  /**
   * Creates the user and profile rows for a new player.
   *
   * @param client Transaction client (the account-creation transaction).
   * @param player The account, with contact and date of birth already encrypted.
   * @throws DatabaseError (unique violation) when the contact is already registered.
   */
  async insertPlayer(client: Queryable, player: NewPlayer): Promise<void> {
    const columns = columnsFor(player.channel);
    await client.query(
      `INSERT INTO users (id, ${columns.enc}, ${columns.bidx}, password_hash) VALUES ($1, $2, $3, $4)`,
      [player.id, player.contactEnc, player.contactBidx, player.passwordHash],
    );
    await client.query(
      `INSERT INTO profiles (user_id, display_name, dob_enc, state_code) VALUES ($1, $2, $3, $4)`,
      [player.id, player.displayName, player.dobEnc, player.stateCode],
    );
  },

  /**
   * @param client Pool or transaction client.
   * @param userId Account.
   * @param hash New argon2id hash.
   */
  async updatePasswordHash(client: Queryable, userId: string, hash: string): Promise<void> {
    await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      userId,
      hash,
    ]);
  },

  /**
   * Sets the account's email or phone.
   *
   * @param client Transaction client.
   * @param input Account, channel, encrypted value, and blind index.
   * @throws DatabaseError (unique violation) when another account has that contact.
   */
  async updateContact(
    client: Queryable,
    input: { userId: string; channel: ContactChannel; enc: string; bidx: string },
  ): Promise<void> {
    const columns = columnsFor(input.channel);
    await client.query(
      `UPDATE users SET ${columns.enc} = $2, ${columns.bidx} = $3, updated_at = now() WHERE id = $1`,
      [input.userId, input.enc, input.bidx],
    );
  },
};
