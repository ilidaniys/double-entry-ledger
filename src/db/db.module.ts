import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { createPool } from './pool';

export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => createPool(),
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
