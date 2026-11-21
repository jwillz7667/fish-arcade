import { ForbiddenError } from '@reef/errors';
import type { ClientBase } from 'pg';

/** The three database roles (playbook Step 3). */
export const DATABASE_ROLES = ['reef_migrator', 'reef_app', 'reef_readonly'] as const;

/** One of {@link DATABASE_ROLES}. */
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

/** Input for {@link bootstrapDatabaseRoles}. */
export interface RoleBootstrapOptions {
  /** Database the roles get access to. reef_migrator becomes its owner. */
  readonly database: string;
  /** Login password per role. */
  readonly passwords: Readonly<Record<DatabaseRole, string>>;
  /** Current NODE_ENV. Production roles come from Terraform, never from this function. */
  readonly nodeEnv: string;
}

/**
 * Creates or updates the reef_migrator, reef_app, and reef_readonly login roles, hands the
 * database and `public` schema to reef_migrator, and closes them to everyone else. Idempotent.
 * Must run as a superuser, in development or CI only.
 *
 * @param client A connection as a superuser.
 * @param options Target database, passwords, and NODE_ENV.
 * @throws ForbiddenError when `nodeEnv` is production.
 */
export async function bootstrapDatabaseRoles(
  client: ClientBase,
  options: RoleBootstrapOptions,
): Promise<void> {
  if (options.nodeEnv === 'production') {
    throw new ForbiddenError({ message: 'Database roles are managed by Terraform in production' });
  }
  // CREATE/ALTER ROLE and ALTER DATABASE accept no bind parameters, so identifiers and the
  // password literal are quoted with the driver's own escaping instead.
  const database = client.escapeIdentifier(options.database);
  for (const role of DATABASE_ROLES) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
    // `role` comes from the DATABASE_ROLES constant, not from input.
    // eslint-disable-next-line security/detect-object-injection
    const password = client.escapeLiteral(options.passwords[role]);
    await client.query(
      `${verb} ROLE ${client.escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${password}`,
    );
  }
  await client.query(`ALTER DATABASE ${database} OWNER TO reef_migrator`);
  await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT ON DATABASE ${database} TO reef_migrator, reef_app, reef_readonly`,
  );
}

/**
 * Hands the `public` schema of the current database to reef_migrator. Run on a connection to
 * the target database after {@link bootstrapDatabaseRoles}.
 *
 * @param client A superuser connection to the target database.
 */
export async function claimPublicSchema(client: ClientBase): Promise<void> {
  await client.query('ALTER SCHEMA public OWNER TO reef_migrator');
  await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
}
