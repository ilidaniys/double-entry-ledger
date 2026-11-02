/**
 * End-to-end walkthrough of the ledger against a real Postgres.
 *
 *   npm run demo
 *
 * Every run creates its own accounts (suffixed with a run id), so it never
 * touches existing data and can be re-run any number of times.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { LedgerError } from '../src/ledger/ledger.errors';
import { LedgerService } from '../src/ledger/ledger.service';

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const ok = (s: string) => console.log(`  ${c.green('✓')} ${s}`);
const rejected = (s: string) => console.log(`  ${c.red('✗')} ${s}`);
const step = (s: string) => console.log(`\n${c.bold(c.cyan('▸ ' + s))}`);

/** Minor units → "1 000.00". */
const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }).replace(/,/g, ' ');

const errorCode = (err: unknown) => (err instanceof LedgerError ? err.code : (err as Error).message);

async function main() {
  await migrate();
  const pool = createPool();
  const ledger = new LedgerService(pool);
  const run = randomUUID().slice(0, 6);

  try {
    step('Chart of accounts');
    const treasury = await ledger.createAccount({
      code: `treasury:USD:${run}`, name: 'Treasury', type: 'asset', currency: 'USD', allowNegative: true,
    });
    const alice = await ledger.createAccount({ code: `user:alice:USD:${run}`, name: 'Alice', type: 'liability', currency: 'USD' });
    const bob = await ledger.createAccount({ code: `user:bob:USD:${run}`, name: 'Bob', type: 'liability', currency: 'USD' });
    const fees = await ledger.createAccount({ code: `house:fees:USD:${run}`, name: 'Fees', type: 'revenue', currency: 'USD' });
    console.log(c.dim('  treasury = asset · alice, bob = liability (we owe them) · fees = revenue'));

    step('Alice deposits 1 000.00');
    await ledger.postEntry({
      idempotencyKey: `deposit:${run}`,
      currency: 'USD',
      postings: [
        { account: treasury.code, side: 'debit', amount: 100_000 },
        { account: alice.code, side: 'credit', amount: 100_000 },
      ],
    });
    ok('debit treasury 1 000.00 / credit alice 1 000.00');

    step('Alice sends Bob 250.00 with a 2.50 fee — one entry, three legs');
    const transfer = {
      idempotencyKey: `transfer:${run}`,
      currency: 'USD',
      postings: [
        { account: alice.code, side: 'debit' as const, amount: 25_250 },
        { account: bob.code, side: 'credit' as const, amount: 25_000 },
        { account: fees.code, side: 'credit' as const, amount: 250 },
      ],
    };
    const first = await ledger.postEntry(transfer);
    ok(`posted entry ${c.dim(first.id.slice(0, 8))}`);

    step('Client retries the same request (network timeout)');
    const retry = await ledger.postEntry(transfer);
    ok(`same entry returned ${c.dim(retry.id.slice(0, 8))}, nothing posted twice`);
    try {
      await ledger.postEntry({ ...transfer, postings: transfer.postings.map((p) => ({ ...p, amount: p.amount * 2 })) });
    } catch (err) {
      rejected(`same key, different amount → ${errorCode(err)}`);
    }

    step('Unbalanced entry');
    try {
      await ledger.postEntry({
        idempotencyKey: `unbalanced:${run}`,
        currency: 'USD',
        postings: [
          { account: alice.code, side: 'debit', amount: 10_000 },
          { account: bob.code, side: 'credit', amount: 9_999 },
        ],
      });
    } catch (err) {
      rejected(`debits 100.00 ≠ credits 99.99 → ${errorCode(err)}`);
    }

    step('Race: 25 parallel withdrawals of 25.00 from Bob (balance 250.00)');
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        ledger.postEntry({
          idempotencyKey: randomUUID(),
          currency: 'USD',
          postings: [
            { account: bob.code, side: 'debit', amount: 2_500 },
            { account: treasury.code, side: 'credit', amount: 2_500 },
          ],
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const failCodes = new Set(failed.map((f) => errorCode(f.reason)));
    ok(`${succeeded} succeeded`);
    rejected(`${failed.length} rejected with ${[...failCodes].join(', ')}`);
    console.log(`  Bob's balance: ${c.bold(usd((await ledger.getBalance(bob.code)).natural))}`);

    step('Tamper with the tables directly (raw SQL, bypassing the service)');
    const entryIds = (await ledger.getStatement(alice.code)).map((l) => l.entryId);
    const attempts: [string, string, unknown[]][] = [
      ['UPDATE a posted amount', 'UPDATE postings SET amount = 1 WHERE entry_id = $1', [first.id]],
      ['DELETE history', 'DELETE FROM journal_entries WHERE id = ANY($1::uuid[])', [entryIds]],
      [
        'INSERT an unbalanced entry',
        `WITH e AS (INSERT INTO journal_entries (idempotency_key, request_hash, currency)
                    VALUES ($3, 'x', 'USD') RETURNING id)
         INSERT INTO postings (entry_id, account_id, side, amount)
         SELECT id, $1::uuid, 'debit'::posting_side, 100000 FROM e
         UNION ALL SELECT id, $2::uuid, 'credit'::posting_side, 1 FROM e`,
        [alice.id, bob.id, `tamper:${run}`],
      ],
    ];
    for (const [label, sql, params] of attempts) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql, params);
        await client.query('COMMIT'); // deferred triggers fire here
        console.log(`  ${c.red('!!')} ${label} went through — invariant broken`);
        process.exitCode = 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        rejected(`${label.padEnd(26)} ${c.dim((err as Error).message)}`);
      } finally {
        client.release();
      }
    }

    step('Balances');
    const rows = await Promise.all(
      [treasury, alice, bob, fees].map(async (a) => ({ a, bal: (await ledger.getBalance(a.code)).natural })),
    );
    for (const { a, bal } of rows) {
      console.log(`  ${a.name.padEnd(10)} ${c.dim(a.type.padEnd(10))} ${usd(bal).padStart(10)}`);
    }
    const [t, al, b, f] = rows.map((r) => r.bal);
    const equation = t === al + b + f;
    (equation ? ok : rejected)(
      `assets ${usd(t)} = liabilities ${usd(al + b)} + revenue ${usd(f)}`,
    );

    const drift = await ledger.findBalanceDrift();
    (drift.length === 0 ? ok : rejected)(
      `reconciliation: materialized balances vs journal → drift ${JSON.stringify(drift)}`,
    );
    if (!equation || drift.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
