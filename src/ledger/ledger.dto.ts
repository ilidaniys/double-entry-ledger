import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { AccountType, Side } from './ledger.types';

const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const SIDES: Side[] = ['debit', 'credit'];

export class CreateAccountDto {
  @IsString() @Length(1, 128) code!: string;
  @IsString() @Length(1, 256) name!: string;
  @IsIn(ACCOUNT_TYPES) type!: AccountType;
  @IsString() @Matches(/^[A-Za-z]{3,10}$/) currency!: string;
  @IsOptional() @IsBoolean() allowNegative?: boolean;
}

export class PostingDto {
  @IsString() @Length(1, 128) account!: string;
  @IsIn(SIDES) side!: Side;
  @IsInt() @IsPositive() amount!: number;
}

export class PostEntryDto {
  @IsString() @Length(1, 256) idempotencyKey!: string;
  @IsString() @Matches(/^[A-Za-z]{3,10}$/) currency!: string;
  @IsOptional() @IsString() @Length(0, 1024) description?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @Type(() => Date) @IsDate() effectiveAt?: Date;
  @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => PostingDto) postings!: PostingDto[];
}
