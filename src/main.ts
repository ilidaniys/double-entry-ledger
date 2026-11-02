import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LedgerExceptionFilter } from './ledger/ledger.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new LedgerExceptionFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`ledger listening on :${port}`);
}

bootstrap();
