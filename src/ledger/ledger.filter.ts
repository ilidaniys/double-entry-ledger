import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { LedgerError, LedgerErrorCode } from './ledger.errors';

const STATUS: Record<LedgerErrorCode, HttpStatus> = {
  UNBALANCED_ENTRY: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_POSTING: HttpStatus.UNPROCESSABLE_ENTITY,
  UNKNOWN_ACCOUNT: HttpStatus.NOT_FOUND,
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
};

@Catch(LedgerError)
export class LedgerExceptionFilter implements ExceptionFilter {
  catch(err: LedgerError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
  }
}
