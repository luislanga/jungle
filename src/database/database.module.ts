import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { readDatabaseConfig, type DatabaseConfig } from '@/config/database';
import { createDatabaseDataSource } from '@/database/data-source';
import { DATABASE_ENTITIES } from '@/database/entities';

export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

@Global()
@Module({
  providers: [
    { provide: DATABASE_CONFIG, useFactory: () => readDatabaseConfig() },
    {
      provide: DataSource,
      inject: [DATABASE_CONFIG],
      useFactory: (config: DatabaseConfig) =>
        createDatabaseDataSource(config, DATABASE_ENTITIES).initialize(),
    },
  ],
  exports: [DataSource, DATABASE_CONFIG],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async onApplicationShutdown() {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
