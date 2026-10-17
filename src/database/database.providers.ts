import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { readDatabaseConfig, type DatabaseConfig } from '@/config/database';
import { createDatabaseDataSource } from '@/database/data-source';
import { createFinancialTransaction } from '@/database/financial-transaction.factory';
import { DATABASE_ENTITIES } from '@/database/entities';

export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');
export const FINANCIAL_TRANSACTION = Symbol('FINANCIAL_TRANSACTION');

export const DATABASE_PROVIDERS: Provider[] = [
  { provide: DATABASE_CONFIG, useFactory: () => readDatabaseConfig() },
  {
    provide: DataSource,
    inject: [DATABASE_CONFIG],
    useFactory: (config: DatabaseConfig) =>
      createDatabaseDataSource(config, DATABASE_ENTITIES).initialize(),
  },
  {
    provide: FINANCIAL_TRANSACTION,
    inject: [DataSource, DATABASE_CONFIG],
    useFactory: (dataSource: DataSource, config: DatabaseConfig) =>
      createFinancialTransaction(dataSource, config),
  },
];
