import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withTransaction } from '../db/pool';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidPostingError,
  UnbalancedEntryError,
  UnknownAccountError,
} from './ledger.errors';
import {
  Account,
  AccountBalance,
  AccountType,
  JournalEntry,
  PostEntryCommand,
  PostingInput,
  StatementLine,
  normalSide,
} from './ledger.types';

/** Thrown internally when a concurrent request won the idempotency race; triggers one retry. */
class IdempotencyRaceLost extends Error {}

const PG_UNIQUE_VIOLATION = '23505';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LedgerService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async createAccount(input: {
    code: string;
    name: string;
    type: AccountType;
    currency: string;
    allowNegative?: boolean;
  }): Promise<Account> {
    const { rows } = await this.pool.query(
      `INSERT INTO accounts (code, name, type, currency, allow_negative)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, code, name, type, currency, allow_negative`,
      [input.code, input.name, input.type, input.currency.toUpperCase(), input.allowNegative ?? false],
    );
    return mapAccount(rows[0]);
  }

  async getBalance(accountRef: string): Promise<AccountBalance> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.code, a.type, a.currency, b.balance, b.version
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        WHERE a.code = $1 OR a.id::text = $1`,
      [accountRef],
    );
    if (!rows[0]) throw new UnknownAccountError(accountRef);
    return mapBalance(rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Journal
  // ---------------------------------------------------------------------------

  /**
   * Posts a balanced journal entry atomically.
   *
   * Concurrency model: READ COMMITTED + explicit row locks on account_balances,
   * acquired one at a time in ascending account_id order. Two entries touching
   * overlapping accounts always lock them in the same order, so they cannot
   * deadlock; they serialize on the first shared account. Entries with disjoint
   * accounts run fully in parallel.
   *
   * Idempotency: the key is checked *after* the locks are held, so a duplicate
   * request waits for the original to commit and then sees it. The unique index
   * on idempotency_key is the last line of defence for requests that touch no
   * common accounts in the same order (shouldn't happen, but is handled).
   */
  async postEntry(cmd: PostEntryCommand): Promise<JournalEntry> {
    validateCommand(cmd);
    const requestHash = hashCommand(cmd);

    try {
      return await withTransaction(this.pool, (tx) => this.postEntryTx(tx, cmd, requestHash));
    } catch (err) {
      if (err instanceof IdempotencyRaceLost) {
        // The other request has committed by now; this pass will find it.
        return withTransaction(this.pool, (tx) => this.postEntryTx(tx, cmd, requestHash));
      }
      throw err;
    }
  }

  private async postEntryTx(
    tx: PoolClient,
    cmd: PostEntryCommand,
    requestHash: string,
  ): Promise<JournalEntry> {
    const currency = cmd.currency.toUpperCase();
    const accounts = await this.resolveAccounts(tx, cmd.postings, currency);

    // Net movement per account (debits positive, credits negative), merged so an
    // account appearing twice in one entry is locked and checked once.
    const deltas = new Map<string, number>();
    for (const p of cmd.postings) {
      const acc = accounts.get(p.account)!;
      const signed = p.side === 'debit' ? p.amount : -p.amount;
      deltas.set(acc.id, (deltas.get(acc.id) ?? 0) + signed);
    }

    const lockedBalances = await this.lockBalances(tx, [...deltas.keys()]);

    const existing = await this.findByIdempotencyKey(tx, cmd.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(cmd.idempotencyKey);
      }
      return this.loadEntry(tx, existing.id);
    }

    const entryId = await this.insertEntry(tx, cmd, currency, requestHash);
    await this.insertPostings(tx, entryId, cmd.postings, accounts);

    for (const [accountId, delta] of deltas) {
      const before = lockedBalances.get(accountId)!;
      const account = [...accounts.values()].find((a) => a.id === accountId)!;
      const after = before + delta;

      const natural = normalSide(account.type) === 'debit' ? after : -after;
      if (natural < 0 && !account.allowNegative) {
        const availableBefore = normalSide(account.type) === 'debit' ? before : -before;
        throw new InsufficientFundsError(account.code, availableBefore, availableBefore - natural);
      }

      await tx.query(
        `UPDATE account_balances
            SET balance = $2, version = version + 1, updated_at = now()
          WHERE account_id = $1`,
        [accountId, after],
      );
    }

    return this.loadEntry(tx, entryId);
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    // A malformed id is "not found", not a 500; any other failure must surface.
    if (!UUID_RE.test(id)) return null;
    const { rowCount } = await this.pool.query('SELECT 1 FROM journal_entries WHERE id = $1', [id]);
    if (!rowCount) return null;
    return this.loadEntry(this.pool, id);
  }

  /** Most recent entries first, with their postings. */
  async listEntries(limit = 50): Promise<JournalEntry[]> {
    const { rows } = await this.pool.query(
      'SELECT id FROM journal_entries ORDER BY created_at DESC, id LIMIT $1',
      [limit],
    );
    return Promise.all(rows.map((r) => this.loadEntry(this.pool, r.id)));
  }

  /** Chart of accounts with current balances. */
  async listAccounts(): Promise<(Account & AccountBalance)[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.code, a.name, a.type, a.currency, a.allow_negative, b.balance, b.version
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        ORDER BY a.created_at, a.code`,
    );
    return rows.map((r) => ({ ...mapAccount(r), ...mapBalance(r) }));
  }

  /**
   * Account statement: every posting to the account, oldest first, with the
   * running natural balance after each line. Derived from the journal alone.
   */
  async getStatement(accountRef: string): Promise<StatementLine[]> {
    const account = await this.getBalance(accountRef);
    const { rows } = await this.pool.query(
      `SELECT p.id, p.entry_id, p.side, p.amount, e.description, e.effective_at,
              SUM(CASE WHEN p.side = 'debit' THEN p.amount ELSE -p.amount END)
                OVER (ORDER BY p.id) AS running
         FROM postings p
         JOIN journal_entries e ON e.id = p.entry_id
        WHERE p.account_id = $1
        ORDER BY p.id`,
      [account.accountId],
    );
    const toNatural = (raw: number) => (normalSide(account.type) === 'debit' ? raw : 0 - raw);
    return rows.map((r) => ({
      postingId: Number(r.id),
      entryId: r.entry_id,
      description: r.description,
      effectiveAt: r.effective_at,
      side: r.side,
      amount: Number(r.amount),
      balanceAfter: toNatural(Number(r.running)),
    }));
  }

  /** Accounts whose materialized balance disagrees with the journal. Must be empty. */
  async findBalanceDrift(): Promise<{ accountId: string; materialized: number; computed: number }[]> {
    const { rows } = await this.pool.query('SELECT * FROM balance_drift');
    return rows.map((r) => ({
      accountId: r.account_id,
      materialized: Number(r.materialized),
      computed: Number(r.computed),
    }));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveAccounts(
    tx: PoolClient,
    postings: PostingInput[],
    currency: string,
  ): Promise<Map<string, Account>> {
    const refs = [...new Set(postings.map((p) => p.account))];
    const { rows } = await tx.query(
      `SELECT id, code, name, type, currency, allow_negative
         FROM accounts
        WHERE code = ANY($1) OR id::text = ANY($1)`,
      [refs],
    );

    const byRef = new Map<string, Account>();
    for (const row of rows) {
      const acc = mapAccount(row);
      byRef.set(acc.id, acc);
      byRef.set(acc.code, acc);
    }

    for (const ref of refs) {
      const acc = byRef.get(ref);
      if (!acc) throw new UnknownAccountError(ref);
      if (acc.currency !== currency) {
        throw new CurrencyMismatchError(acc.code, acc.currency, currency);
      }
    }
    return byRef;
  }

  /** Locks balance rows one by one in sorted order and returns current balances. */
  private async lockBalances(tx: PoolClient, accountIds: string[]): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    for (const id of [...accountIds].sort()) {
      const { rows } = await tx.query(
        'SELECT balance FROM account_balances WHERE account_id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new UnknownAccountError(id);
      balances.set(id, Number(rows[0].balance));
    }
    return balances;
  }

  private async findByIdempotencyKey(
    tx: PoolClient,
    key: string,
  ): Promise<{ id: string; requestHash: string } | null> {
    const { rows } = await tx.query(
      'SELECT id, request_hash FROM journal_entries WHERE idempotency_key = $1',
      [key],
    );
    return rows[0] ? { id: rows[0].id, requestHash: rows[0].request_hash } : null;
  }

  private async insertEntry(
    tx: PoolClient,
    cmd: PostEntryCommand,
    currency: string,
    requestHash: string,
  ): Promise<string> {
    try {
      const { rows } = await tx.query(
        `INSERT INTO journal_entries
           (idempotency_key, request_hash, currency, description, metadata, effective_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
         RETURNING id`,
        [
          cmd.idempotencyKey,
          requestHash,
          currency,
          cmd.description ?? '',
          JSON.stringify(cmd.metadata ?? {}),
          cmd.effectiveAt ?? null,
        ],
      );
      return rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new IdempotencyRaceLost();
      }
      throw err;
    }
  }

  private async insertPostings(
    tx: PoolClient,
    entryId: string,
    postings: PostingInput[],
    accounts: Map<string, Account>,
  ): Promise<void> {
    const values: unknown[] = [];
    const tuples = postings.map((p, i) => {
      const base = i * 4;
      values.push(entryId, accounts.get(p.account)!.id, p.side, p.amount);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    await tx.query(
      `INSERT INTO postings (entry_id, account_id, side, amount) VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  private async loadEntry(client: Pick<PoolClient, 'query'>, id: string): Promise<JournalEntry> {
    const entry = await client.query('SELECT * FROM journal_entries WHERE id = $1', [id]);
    if (!entry.rows[0]) throw new Error(`entry ${id} not found`);
    const postings = await client.query(
      'SELECT id, account_id, side, amount FROM postings WHERE entry_id = $1 ORDER BY id',
      [id],
    );
    const e = entry.rows[0];
    return {
      id: e.id,
      idempotencyKey: e.idempotency_key,
      currency: e.currency,
      description: e.description,
      metadata: e.metadata,
      effectiveAt: e.effective_at,
      createdAt: e.created_at,
      postings: postings.rows.map((p) => ({
        id: Number(p.id),
        accountId: p.account_id,
        side: p.side,
        amount: Number(p.amount),
      })),
    };
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

function validateCommand(cmd: PostEntryCommand): void {
  if (!cmd.idempotencyKey?.trim()) throw new InvalidPostingError('idempotencyKey is required');
  if (!cmd.currency?.trim()) throw new InvalidPostingError('currency is required');
  if (!Array.isArray(cmd.postings) || cmd.postings.length < 2) {
    throw new InvalidPostingError('an entry needs at least two postings');
  }

  let net = 0;
  for (const p of cmd.postings) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
      throw new InvalidPostingError(`amount must be a positive integer in minor units, got ${p.amount}`);
    }
    if (p.side !== 'debit' && p.side !== 'credit') {
      throw new InvalidPostingError(`side must be 'debit' or 'credit', got ${String(p.side)}`);
    }
    net += p.side === 'debit' ? p.amount : -p.amount;
  }
  if (net !== 0) throw new UnbalancedEntryError(net);
}

/** Stable hash of the business content of a request, used to detect key reuse with a different payload. */
function hashCommand(cmd: PostEntryCommand): string {
  const canonical = {
    currency: cmd.currency.toUpperCase(),
    description: cmd.description ?? '',
    metadata: cmd.metadata ?? {},
    effectiveAt: cmd.effectiveAt?.toISOString() ?? null,
    postings: [...cmd.postings]
      .map((p) => ({ account: p.account, side: p.side, amount: p.amount }))
      .sort((a, b) => `${a.account}${a.side}${a.amount}`.localeCompare(`${b.account}${b.side}${b.amount}`)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function mapAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    type: row.type as AccountType,
    currency: row.currency as string,
    allowNegative: row.allow_negative as boolean,
  };
}

function mapBalance(row: Record<string, unknown>): AccountBalance {
  const raw = Number(row.balance);
  const type = row.type as AccountType;
  return {
    accountId: row.id as string,
    code: row.code as string,
    type,
    currency: row.currency as string,
    raw,
    natural: normalSide(type) === 'debit' ? raw : 0 - raw, // `0 - raw` avoids JS -0
    version: Number(row.version),
  };
}
