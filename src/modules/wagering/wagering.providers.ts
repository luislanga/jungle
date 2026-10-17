import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/database/database.module';
import type { DatabaseConfig } from '@/config/database';
import { GetWagerTransactionUseCase } from '@/modules/wagering/application/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';

export const WAGERING_PROVIDERS: Provider[] = [
  ChallengeAuthGuard,
  {
    provide: GetWagerTransactionUseCase,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) =>
      new GetWagerTransactionUseCase(new WagerTransactionRepository(dataSource.manager)),
  },
  {
    provide: ProcessWagerTransactionUseCase,
    inject: [DataSource, DATABASE_CONFIG],
    useFactory: (dataSource: DataSource, config: DatabaseConfig) =>
      new ProcessWagerTransactionUseCase(dataSource, config),
  },
];
