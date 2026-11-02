export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type Side = 'debit' | 'credit';

/** Which side increases the account. Assets/expenses grow on debit, the rest on credit. */
export function normalSide(type: AccountType): Side {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative: boolean;
}

export interface PostingInput {
  /** Account id or account code — resolved by the service. */
  account: string;
  side: Side;
  /** Minor units (cents, satoshi). Must be a positive safe integer. */
  amount: number;
}

export interface PostEntryCommand {
  idempotencyKey: string;
  currency: string;
  description?: string;
  metadata?: Record<string, unknown>;
  effectiveAt?: Date;
  postings: PostingInput[];
}

export interface Posting {
  id: number;
  accountId: string;
  side: Side;
  amount: number;
}

export interface JournalEntry {
  id: string;
  idempotencyKey: string;
  currency: string;
  description: string;
  metadata: Record<string, unknown>;
  effectiveAt: Date;
  createdAt: Date;
  postings: Posting[];
}

export interface AccountBalance {
  accountId: string;
  code: string;
  type: AccountType;
  currency: string;
  /** Raw stored value: debits - credits. */
  raw: number;
  /** Positive when the account holds value, regardless of account type. */
  natural: number;
  version: number;
}

export interface StatementLine {
  postingId: number;
  entryId: string;
  description: string;
  effectiveAt: Date;
  side: Side;
  amount: number;
  /** Natural balance of the account right after this posting. */
  balanceAfter: number;
}
