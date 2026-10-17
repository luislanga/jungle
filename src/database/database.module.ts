import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DATABASE_CONFIG,
  FINANCIAL_TRANSACTION,
  DATABASE_PROVIDERS,
} from '@/database/database.providers';

export { DATABASE_CONFIG, FINANCIAL_TRANSACTION } from '@/database/database.providers';

@Global()
@Module({
  providers: [...DATABASE_PROVIDERS],
  exports: [DataSource, DATABASE_CONFIG, FINANCIAL_TRANSACTION],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async onApplicationShutdown() {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
