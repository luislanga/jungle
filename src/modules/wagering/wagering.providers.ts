import {
  PENDING_REFERENCE_CONFIG,
  readPendingReferenceConfig,
  type PendingReferenceConfig,
} from '@/config/pending-reference';
import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FINANCIAL_TRANSACTION } from '@/database/database.module';
import type { FinancialTransaction } from '@/shared/interfaces/financial-transaction.interface';
import { GetWagerTransactionUseCase } from '@/modules/wagering/application/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';

export const WAGERING_PROVIDERS: Provider[] = [
  ChallengeAuthGuard,
  { provide: PENDING_REFERENCE_CONFIG, useFactory: () => readPendingReferenceConfig() },
  {
    provide: GetWagerTransactionUseCase,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) =>
      new GetWagerTransactionUseCase(new WagerTransactionRepository(dataSource.manager)),
  },
  {
    provide: ProcessWagerTransactionUseCase,
    inject: [FINANCIAL_TRANSACTION, PENDING_REFERENCE_CONFIG],
    useFactory: (transaction: FinancialTransaction, config: PendingReferenceConfig) =>
      new ProcessWagerTransactionUseCase(transaction, config),
  },
];
