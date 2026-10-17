import { DataSource, type DataSourceOptions } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';

// TypeORM connection config
export function createDatabaseDataSource(
  config: DatabaseConfig,
  entities: NonNullable<DataSourceOptions['entities']> = [],
): DataSource {
  return new DataSource({
    type: 'postgres',
    url: config.DATABASE_URL,
    schema: 'wagering',
    entities,
    migrationsRun: false, // Using Liquibase for migrations
    synchronize: false,
    logging: false,
    poolSize: config.DATABASE_POOL_SIZE,
    connectTimeoutMS: config.DATABASE_CONNECT_TIMEOUT_MS,
    parseInt8: false,
    applicationName: 'wagering',
  });
}
