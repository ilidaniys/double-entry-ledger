import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { LedgerService } from '../src/ledger/ledger.service';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidPostingError,
  UnbalancedEntryError,
  CurrencyMismatchError,
} from '../src/ledger/ledger.errors';

/**
 * Integration tests against a real Postgres (see docker-compose.yml).
 * The DB-level invariants are the point of the ledger, so there is no mocking.
 */
describe('LedgerService', () => {
  let pool: Pool;
  let ledger: LedgerService;

  beforeAll(async () => {
    await migrate();
    pool = createPool();
    ledger = new LedgerService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // TRUNCATE bypasses row-level triggers; immutability is enforced on UPDATE/DELETE.
    await pool.query('TRUNCATE postings, journal_entries, account_balances, accounts CASCADE');
  });

  // Customer wallets are liabilities of the exchange; the omnibus bank/treasury
  // account is an asset. Funding a wallet = debit treasury, credit wallet.
  async function setup(fundAlice = 1_000) {
    const u = randomUUID().slice(0, 8);
    const treasury = await ledger.createAccount({
      code: `treasury:USD:${u}`, name: 'Treasury', type: 'asset', currency: 'USD', allowNegative: true,
    });
    const alice = await ledger.createAccount({
      code: `user:alice:USD:${u}`, name: 'Alice', type: 'liability', currency: 'USD',
    });
    const bob = await ledger.createAccount({
      code: `user:bob:USD:${u}`, name: 'Bob', type: 'liability', currency: 'USD',
    });
    const fees = await ledger.createAccount({
      code: `house:fees:USD:${u}`, name: 'Fee revenue', type: 'revenue', currency: 'USD',
    });

    if (fundAlice > 0) {
      await ledger.postEntry({
        idempotencyKey: `fund:${u}`,
        currency: 'USD',
        description: 'deposit',
        postings: [
          { account: treasury.code, side: 'debit', amount: fundAlice },
          { account: alice.code, side: 'credit', amount: fundAlice },
        ],
      });
    }
    return { treasury, alice, bob, fees };
  }

  const transfer = (from: string, to: string, amount: number, key: string = randomUUID()) =>
    ledger.postEntry({
      idempotencyKey: key,
      currency: 'USD',
      postings: [
        { account: from, side: 'debit', amount },
        { account: to, side: 'credit', amount },
      ],
    });

  // ---------------------------------------------------------------------------

  describe('double-entry invariants', () => {
    it('posts a balanced entry and moves balances', async () => {
      const { alice, bob } = await setup();
      await transfer(alice.code, bob.code, 250);

      expect((await ledger.getBalance(alice.code)).natural).toBe(750);
      expect((await ledger.getBalance(bob.code)).natural).toBe(250);
    });

    it('supports multi-leg entries (transfer with fee)', async () => {
      const { alice, bob, fees } = await setup();
      await ledger.postEntry({
        idempotencyKey: 'xfer-with-fee',
        currency: 'USD',
        postings: [
          { account: alice.code, side: 'debit', amount: 100 },
          { account: bob.code, side: 'credit', amount: 98 },
          { account: fees.code, side: 'credit', amount: 2 },
        ],
      });

      expect((await ledger.getBalance(alice.code)).natural).toBe(900);
      expect((await ledger.getBalance(bob.code)).natural).toBe(98);
      expect((await ledger.getBalance(fees.code)).natural).toBe(2);
    });

    it('rejects unbalanced entries in application code', async () => {
      const { alice, bob } = await setup();
      await expect(
        ledger.postEntry({
          idempotencyKey: 'bad',
          currency: 'USD',
          postings: [
            { account: alice.code, side: 'debit', amount: 100 },
            { account: bob.code, side: 'credit', amount: 99 },
          ],
        }),
      ).rejects.toBeInstanceOf(UnbalancedEntryError);
    });

    it('rejects unbalanced entries at the database level too', async () => {
      const { alice, bob } = await setup();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO journal_entries (idempotency_key, request_hash, currency)
           VALUES ('direct', 'x', 'USD') RETURNING id`,
        );
        await client.query(
          `INSERT INTO postings (entry_id, account_id, side, amount)
           VALUES ($1, $2, 'debit', 100), ($1, $3, 'credit', 1)`,
          [rows[0].id, alice.id, bob.id],
        );
        // deferred constraint trigger fires here
        await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
      } finally {
        client.release();
      }
    });

    it('rejects single-posting and non-positive amounts', async () => {
      const { alice, bob } = await setup();
      await expect(
        ledger.postEntry({
          idempotencyKey: 'one',
          currency: 'USD',
          postings: [{ account: alice.code, side: 'debit', amount: 100 }],
        }),
      ).rejects.toBeInstanceOf(InvalidPostingError);

      await expect(
        ledger.postEntry({
          idempotencyKey: 'neg',
          currency: 'USD',
          postings: [
            { account: alice.code, side: 'debit', amount: -5 },
            { account: bob.code, side: 'credit', amount: -5 },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidPostingError);

      await expect(
        ledger.postEntry({
          idempotencyKey: 'float',
          currency: 'USD',
          postings: [
            { account: alice.code, side: 'debit', amount: 1.5 },
            { account: bob.code, side: 'credit', amount: 1.5 },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidPostingError);
    });

    it('rejects mixing currencies in one entry', async () => {
      const { alice } = await setup();
      const eur = await ledger.createAccount({
        code: `user:carol:EUR:${randomUUID().slice(0, 8)}`, name: 'Carol', type: 'liability', currency: 'EUR',
      });
      await expect(transfer(alice.code, eur.code, 10)).rejects.toBeInstanceOf(CurrencyMismatchError);
    });

    it('journal is append-only', async () => {
      const { alice, bob } = await setup();
      const entry = await transfer(alice.code, bob.code, 10);

      await expect(
        pool.query('UPDATE postings SET amount = 1 WHERE entry_id = $1', [entry.id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query('DELETE FROM journal_entries WHERE id = $1', [entry.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ---------------------------------------------------------------------------

  describe('overdraft protection', () => {
    it('rejects and rolls back entirely when funds are insufficient', async () => {
      const { alice, bob } = await setup(100);

      await expect(transfer(alice.code, bob.code, 101, 'overdraw')).rejects.toBeInstanceOf(
        InsufficientFundsError,
      );

      expect((await ledger.getBalance(alice.code)).natural).toBe(100);
      expect((await ledger.getBalance(bob.code)).natural).toBe(0);
      const { rowCount } = await pool.query(
        "SELECT 1 FROM journal_entries WHERE idempotency_key = 'overdraw'",
      );
      expect(rowCount).toBe(0);
    });

    it('allows exact drain to zero', async () => {
      const { alice, bob } = await setup(100);
      await transfer(alice.code, bob.code, 100);
      expect((await ledger.getBalance(alice.code)).natural).toBe(0);
    });

    it('lets allowNegative accounts go negative (treasury)', async () => {
      const { treasury } = await setup(0);
      const opex = await ledger.createAccount({
        code: `expense:ops:USD:${randomUUID().slice(0, 8)}`, name: 'Operating expenses', type: 'expense', currency: 'USD',
      });
      // Paying an expense out of an empty treasury: the asset goes below zero.
      await transfer(opex.code, treasury.code, 300);
      expect((await ledger.getBalance(treasury.code)).natural).toBe(-300);
      expect((await ledger.getBalance(opex.code)).natural).toBe(300);
    });
  });

  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns the original entry for a repeated request and posts once', async () => {
      const { alice, bob } = await setup();
      const a = await transfer(alice.code, bob.code, 100, 'same-key');
      const b = await transfer(alice.code, bob.code, 100, 'same-key');

      expect(b.id).toBe(a.id);
      expect((await ledger.getBalance(alice.code)).natural).toBe(900);
    });

    it('rejects reuse of a key with a different payload', async () => {
      const { alice, bob } = await setup();
      await transfer(alice.code, bob.code, 100, 'k');
      await expect(transfer(alice.code, bob.code, 200, 'k')).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('collapses concurrent identical requests into one entry', async () => {
      const { alice, bob } = await setup();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => transfer(alice.code, bob.code, 100, 'burst')),
      );
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect((await ledger.getBalance(alice.code)).natural).toBe(900);
    });
  });

  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('never overdraws under parallel transfers', async () => {
      const { alice, bob } = await setup(1_000);

      const attempts = 25; // 25 * 100 = 2_500 requested, only 1_000 available
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => transfer(alice.code, bob.code, 100)),
      );

      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(ok).toBe(10);
      expect(failed).toHaveLength(15);
      failed.forEach((f) => expect(f.reason).toBeInstanceOf(InsufficientFundsError));

      expect((await ledger.getBalance(alice.code)).natural).toBe(0);
      expect((await ledger.getBalance(bob.code)).natural).toBe(1_000);
      expect(await ledger.findBalanceDrift()).toEqual([]);
    });

    it('does not deadlock on opposing transfers', async () => {
      const { alice, bob } = await setup(1_000);
      await transfer(alice.code, bob.code, 500); // both have 500 now

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0 ? transfer(alice.code, bob.code, 10) : transfer(bob.code, alice.code, 10),
        ),
      );

      expect((await ledger.getBalance(alice.code)).natural).toBe(500);
      expect((await ledger.getBalance(bob.code)).natural).toBe(500);
      expect(await ledger.findBalanceDrift()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------

  describe('read side', () => {
    it('statement shows every posting with a running balance', async () => {
      const { alice, bob } = await setup(1_000);
      await transfer(alice.code, bob.code, 300);
      await transfer(bob.code, alice.code, 50);

      const lines = await ledger.getStatement(alice.code);
      expect(lines.map((l) => [l.side, l.amount, l.balanceAfter])).toEqual([
        ['credit', 1_000, 1_000],
        ['debit', 300, 700],
        ['credit', 50, 750],
      ]);
      expect(lines.at(-1)!.balanceAfter).toBe((await ledger.getBalance(alice.code)).natural);
    });

    it('lists accounts with balances and entries newest first', async () => {
      const { alice, bob } = await setup(1_000);
      const last = await transfer(alice.code, bob.code, 1);

      const accounts = await ledger.listAccounts();
      expect(accounts.find((a) => a.code === alice.code)!.natural).toBe(999);

      const entries = await ledger.listEntries(10);
      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe(last.id);
    });

    it('getEntry returns null for unknown or malformed ids', async () => {
      await expect(ledger.getEntry(randomUUID())).resolves.toBeNull();
      await expect(ledger.getEntry('not-a-uuid')).resolves.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------

  describe('reconciliation', () => {
    it('materialized balances match the journal after mixed activity', async () => {
      const { alice, bob, fees } = await setup(5_000);
      for (let i = 0; i < 30; i++) {
        await ledger.postEntry({
          idempotencyKey: `mixed-${i}`,
          currency: 'USD',
          postings: [
            { account: alice.code, side: 'debit', amount: 100 },
            { account: bob.code, side: 'credit', amount: 99 },
            { account: fees.code, side: 'credit', amount: 1 },
          ],
        });
      }
      expect(await ledger.findBalanceDrift()).toEqual([]);

      // Accounting equation: what the exchange owes (liabilities + revenue)
      // must equal what it holds (treasury asset).
      const a = (await ledger.getBalance(alice.code)).natural;
      const b = (await ledger.getBalance(bob.code)).natural;
      const f = (await ledger.getBalance(fees.code)).natural;
      expect(a + b + f).toBe(5_000);
    });
  });
});
