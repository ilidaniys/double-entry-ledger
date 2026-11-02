import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateAccountDto, PostEntryDto } from './ledger.dto';
import { LedgerService } from './ledger.service';

@Controller()
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('accounts')
  createAccount(@Body() dto: CreateAccountDto) {
    return this.ledger.createAccount(dto);
  }

  @Get('accounts')
  listAccounts() {
    return this.ledger.listAccounts();
  }

  @Get('accounts/:ref/balance')
  getBalance(@Param('ref') ref: string) {
    return this.ledger.getBalance(ref);
  }

  /** Every posting to the account with the running balance, derived from the journal. */
  @Get('accounts/:ref/statement')
  getStatement(@Param('ref') ref: string) {
    return this.ledger.getStatement(ref);
  }

  @Get('entries')
  listEntries(@Query('limit') limit = '50') {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new BadRequestException('limit must be an integer between 1 and 500');
    }
    return this.ledger.listEntries(n);
  }

  @Post('entries')
  postEntry(@Body() dto: PostEntryDto) {
    return this.ledger.postEntry(dto);
  }

  @Get('entries/:id')
  async getEntry(@Param('id') id: string) {
    const entry = await this.ledger.getEntry(id);
    if (!entry) throw new NotFoundException(`entry ${id} not found`);
    return entry;
  }

  /** Empty array = ledger is consistent. */
  @Get('reconciliation/drift')
  drift() {
    return this.ledger.findBalanceDrift();
  }
}
