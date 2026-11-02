import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [DbModule, LedgerModule],
})
export class AppModule {}
