# Double-entry ledger

A small, correct-by-construction double-entry ledger on **NestJS + PostgreSQL**.
The point of the repo is not the HTTP API — it is the set of invariants, where each one
is enforced, and the tests that prove they hold under concurrency.

![npm test and npm run demo](docs/demo.gif)

```
npm install
docker compose up -d        # Postgres 16 on :5432
cp .env.example .env
npm run migrate
npm test                    # 19 integration tests against the real database
npm run demo                # end-to-end walkthrough: race, idempotency, raw-SQL tampering, reconciliation
npm run start:dev           # API on :3000
```

`npm run demo` (`scripts/demo.ts`) creates its own accounts on every run, so it is safe
to re-run against the same database.

## Model

Textbook double-entry: every **journal entry** consists of two or more **postings**,
each posting is a `debit` or `credit` of a positive amount to one **account**, and the
debits of an entry always equal its credits.

```
accounts            chart of accounts: code, type (asset|liability|equity|revenue|expense), currency
journal_entries     one business event: idempotency_key, currency, description, effective_at
postings            append-only lines of an entry: account_id, side, amount
account_balances    materialized running balance per account, updated in the same transaction
```

In an exchange, customer wallets are **liabilities** (money the exchange owes) and the
omnibus treasury account is an **asset**. A deposit is `debit treasury / credit wallet`;
a transfer between users is `debit sender / credit receiver`; a fee is a third leg
`credit house:fees`. Nothing is ever "subtracted from a balance" directly — balances are
a consequence of postings.

Amounts are `bigint` in **minor units** (cents, satoshi). Never floats, never decimals in
application code. Direction is carried by `side`, never by the sign of the amount.

## Invariants and where they live

| Invariant | Application | Database |
|---|---|---|
| Σ debits = Σ credits per entry | `validateCommand()` | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` — checked at `COMMIT`, after all postings of the entry are in |
| ≥ 2 postings per entry | yes | same trigger |
| amount > 0, integer | yes | `CHECK (amount > 0)`, `bigint` |
| all postings in the entry's currency | yes | `BEFORE INSERT` trigger comparing account vs entry currency |
| journal is append-only | no `UPDATE`/`DELETE` code paths | `BEFORE UPDATE OR DELETE` triggers raise on `journal_entries` and `postings` |
| one idempotency key → one entry | checked under row locks | `UNIQUE (idempotency_key)` |
| no overdraft on `allow_negative = false` accounts | checked while holding `FOR UPDATE` lock on the balance row | — (see "What I'd add") |
| materialized balance = Σ postings | updated in the same transaction | `balance_drift` view for reconciliation |

The rule of thumb: **the application validates early for good error messages; the
database enforces so that no code path, bug, or script can violate the invariant.** A test
inserts an unbalanced entry with raw SQL and asserts that `COMMIT` fails.

## Concurrency

`postEntry` runs in one `READ COMMITTED` transaction:

1. Resolve accounts, compute the net delta per account.
2. Lock the `account_balances` rows **one at a time, in ascending `account_id` order**
   with `SELECT … FOR UPDATE`.
3. Check the idempotency key *after* the locks are held.
4. Insert the entry and its postings.
5. Apply deltas to the locked balance rows; reject if a non-overdraftable account would go
   below zero on its normal side. The rejection rolls back everything — no entry, no
   postings, no balance change.

Why this shape:

- **Deterministic lock order** means two entries touching overlapping accounts always
  acquire locks in the same sequence, so they cannot deadlock — they just serialize on the
  first shared account. Entries on disjoint accounts run fully in parallel. The test
  `does not deadlock on opposing transfers` fires 20 A→B and B→A transfers concurrently.
- **Overdraft check under the lock** is what makes `never overdraws under parallel
  transfers` pass: 25 concurrent withdrawals of 100 from a balance of 1 000 yield exactly
  10 successes, 15 `INSUFFICIENT_FUNDS`, a final balance of exactly 0 and no drift.
- **Idempotency check after the lock** means a duplicate request waits for the original
  to commit and then returns the same entry instead of double-posting. The unique index
  is the backstop; a unique violation triggers a single retry that finds the committed
  entry. The request payload is hashed; reusing a key with a different payload is a
  `409 IDEMPOTENCY_CONFLICT`, not a silent success.

Alternatives considered: `SERIALIZABLE` with retry on `40001` (simpler code, but retries
under contention on hot accounts like treasury), and `pg_advisory_xact_lock` per account
(same effect, less visible in `pg_locks`). Row locks were chosen because the balance row
is what we need to read-then-write anyway.

## Balances

Two sources of truth that must agree:

- `account_balances.balance` — materialized, O(1) read, updated transactionally.
  Stored as `debits − credits` for every account type; the API exposes `natural` (positive
  = the account holds value) derived from the account's normal side.
- `account_balances_computed` — `SUM` over postings. Slow, but derived purely from the
  append-only journal.

`balance_drift` joins the two and must always be empty. `GET /reconciliation/drift`
exposes it; a production system would run it on a schedule and page on any row.

## API

```
POST /accounts                       { code, name, type, currency, allowNegative? }
GET  /accounts                       chart of accounts with balances
GET  /accounts/:codeOrId/balance     → { raw, natural, version, … }
GET  /accounts/:codeOrId/statement   every posting with the running balance, derived from the journal
POST /entries                        { idempotencyKey, currency, description?, postings: [{ account, side, amount }] }
GET  /entries?limit=50               newest first
GET  /entries/:id
GET  /reconciliation/drift           → [] when consistent
```

Errors are typed (`UNBALANCED_ENTRY`, `INSUFFICIENT_FUNDS`, `IDEMPOTENCY_CONFLICT`, …)
and mapped to HTTP status in one place (`ledger.filter.ts`).

## Tests

`test/ledger.spec.ts` runs against a real Postgres — no mocks, because the database-level
guarantees are the product. Coverage: balanced/unbalanced entries (both layers), multi-leg
entries, currency mixing, append-only enforcement, overdraft rollback, idempotency
(sequential and 10-way concurrent), 25-way concurrent overdraft race, opposing-transfer
deadlock check, statements and listings, reconciliation after mixed activity.

## What I'd add for production

Deliberately out of scope here, listed roughly in the order I'd do them:

- **Overdraft as a DB constraint.** Today the check is application-side under a lock. A
  `CHECK` on `account_balances` conditioned on `accounts.allow_negative` needs a trigger
  or a denormalized column; worth adding so the last line of defence is in the database.
- **Lock down `TRUNCATE` and superuser access.** Row triggers don't fire on `TRUNCATE`;
  the application role should have only `INSERT`/`SELECT` on journal tables.
- **Balance snapshots + partitioning of `postings`** by month/account range so
  reconciliation and history queries don't scan the whole journal.
- **Multi-currency entries** via explicit FX legs through a conversion account, rather than
  the current single-currency-per-entry rule.
- **Outbox table** for publishing posted entries to downstream consumers (notifications,
  risk, reporting) without dual-write problems.
- **`BigInt` end-to-end** instead of `Number` once amounts can exceed 2^53 minor units
  (relevant for 18-decimal tokens).
- **Hot-account contention**: treasury/fee accounts participate in nearly every entry and
  serialize on their lock. Standard mitigations are sharded sub-accounts rolled up on read,
  or batching fee postings.
- **Audit metadata** on entries (actor, source system, correlation id), already sketched
  as `metadata jsonb`.
- **Reversals** as new compensating entries that reference the original, never edits.
