import type { Pool, PoolClient } from 'pg';

/** A `pg` pool or client. Every value is a bound parameter. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;
