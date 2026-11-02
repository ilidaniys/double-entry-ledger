export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type LedgerErrorCode =
  | 'UNBALANCED_ENTRY'
  | 'INVALID_POSTING'
  | 'UNKNOWN_ACCOUNT'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'IDEMPOTENCY_CONFLICT';

export class UnbalancedEntryError extends LedgerError {
  constructor(net: number) {
    super(`entry is unbalanced: debits - credits = ${net}`, 'UNBALANCED_ENTRY');
  }
}

export class InvalidPostingError extends LedgerError {
  constructor(reason: string) {
    super(reason, 'INVALID_POSTING');
  }
}

export class UnknownAccountError extends LedgerError {
  constructor(ref: string) {
    super(`unknown account: ${ref}`, 'UNKNOWN_ACCOUNT');
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(accountCode: string, accountCcy: string, entryCcy: string) {
    super(
      `account ${accountCode} is in ${accountCcy}, entry is in ${entryCcy}`,
      'CURRENCY_MISMATCH',
    );
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(accountCode: string, available: number, required: number) {
    super(
      `insufficient funds in ${accountCode}: available ${available}, required ${required}`,
      'INSUFFICIENT_FUNDS',
    );
  }
}

/** Same idempotency key reused with a different payload. */
export class IdempotencyConflictError extends LedgerError {
  constructor(key: string) {
    super(`idempotency key ${key} was already used with a different request`, 'IDEMPOTENCY_CONFLICT');
  }
}
