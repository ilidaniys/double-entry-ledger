-- Double-entry ledger schema.
--
-- Guarantees that live in the database, not only in application code:
--   1. Every journal entry is balanced: sum(debits) = sum(credits).
--      Enforced by a DEFERRED constraint trigger, checked at COMMIT.
--   2. Journal entries and postings are append-only. UPDATE/DELETE are rejected.
--   3. All postings of an entry are in the entry's currency.
--   4. Amounts are integers in minor units (cents, satoshi) and strictly positive;
--      direction is carried by `side`, never by the sign.
--   5. An idempotency key maps to exactly one entry.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE posting_side AS ENUM ('debit', 'credit');

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,            -- e.g. 'user:42:USD', 'house:fees:USD'
  name           text NOT NULL,
  type           account_type NOT NULL,
  currency       text NOT NULL CHECK (currency = upper(currency) AND length(currency) BETWEEN 3 AND 10),
  allow_negative boolean NOT NULL DEFAULT false,  -- false => cannot be overdrawn on its normal side
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Materialized running balance, one row per account, maintained transactionally
-- together with postings. `balance` is stored as (debits - credits) regardless of
-- account type; the "natural" balance (positive = account holds value) is derived
-- from the account's normal side. `version` lets clients detect concurrent change.
CREATE TABLE account_balances (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  balance    bigint NOT NULL DEFAULT 0,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every account gets a balance row at creation time so that locking
-- `account_balances` rows is always possible (no INSERT races on first use).
CREATE FUNCTION create_balance_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_balances (account_id) VALUES (NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_create_balance
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION create_balance_row();

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,                  -- sha256 of the normalized request
  currency        text NOT NULL,
  description     text NOT NULL DEFAULT '',
  metadata        jsonb NOT NULL DEFAULT '{}',
  effective_at    timestamptz NOT NULL DEFAULT now(),  -- business time
  created_at      timestamptz NOT NULL DEFAULT now()   -- insertion time
);

CREATE TABLE postings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  side       posting_side NOT NULL,
  amount     bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX postings_account_id_idx ON postings (account_id, id);
CREATE INDEX postings_entry_id_idx   ON postings (entry_id);

-- ---------------------------------------------------------------------------
-- Invariant 1: balanced entries (checked at commit, so multi-row inserts work)
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_net   bigint;
  v_count int;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE -amount END), 0), COUNT(*)
    INTO v_net, v_count
    FROM postings
   WHERE entry_id = NEW.entry_id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two postings', NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_net <> 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced by %', NEW.entry_id, v_net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- Invariant 3: posting account currency matches entry currency
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_posting_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account_ccy text;
  v_entry_ccy   text;
BEGIN
  SELECT currency INTO v_account_ccy FROM accounts WHERE id = NEW.account_id;
  SELECT currency INTO v_entry_ccy FROM journal_entries WHERE id = NEW.entry_id;

  IF v_account_ccy IS DISTINCT FROM v_entry_ccy THEN
    RAISE EXCEPTION 'account % is in %, entry % is in %',
      NEW.account_id, v_account_ccy, NEW.entry_id, v_entry_ccy
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER postings_currency
  BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION assert_posting_currency();

-- ---------------------------------------------------------------------------
-- Invariant 2: append-only journal
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER postings_immutable
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Reconciliation: balance recomputed from the journal. Must always equal
-- account_balances.balance; any drift means a bug or tampering.
-- ---------------------------------------------------------------------------
CREATE VIEW account_balances_computed AS
SELECT
  a.id AS account_id,
  COALESCE(SUM(CASE WHEN p.side = 'debit' THEN p.amount ELSE -p.amount END), 0)::bigint AS balance
FROM accounts a
LEFT JOIN postings p ON p.account_id = a.id
GROUP BY a.id;

CREATE VIEW balance_drift AS
SELECT b.account_id, b.balance AS materialized, c.balance AS computed
FROM account_balances b
JOIN account_balances_computed c USING (account_id)
WHERE b.balance <> c.balance;
