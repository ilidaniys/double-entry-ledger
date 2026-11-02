/**
 * Minimal forward-only SQL migration runner.
 * Applies migrations/*.sql in lexical order, each in its own transaction,
 * and records them in schema_migrations. Idempotent: re-running is a no-op.
 *
 *   npm run migrate
 *   DATABASE_URL=... npm run migrate
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, withTransaction } from './pool';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export async function migrate(connectionString?: string): Promise<string[]> {
  const pool = createPool(connectionString);
  const applied: string[] = [];
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (rowCount) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      applied.push(file);
    }
  } finally {
    await pool.end();
  }
  return applied;
}

if (require.main === module) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
