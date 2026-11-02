import { Pool, PoolClient } from 'pg';

export type Queryable = Pick<PoolClient, 'query'>;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  // bigint columns come back from pg as strings. The ledger converts them with
  // Number() at the mapping layer because amounts stay within 2^53 minor units;
  // beyond that they should stay strings/BigInt end-to-end (see README).
  return new Pool({ connectionString });
}

/**
 * Runs `fn` inside a transaction. Commits on success, rolls back on any throw.
 * The ledger relies on this for: deferred constraint triggers (checked at COMMIT),
 * row locks released at COMMIT, and all-or-nothing posting of an entry.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken; original error is what matters */
    }
    throw err;
  } finally {
    client.release();
  }
}
