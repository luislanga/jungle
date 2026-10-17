import { ReconcileWalletUseCase } from '@/modules/wallet/application/reconcile-wallet.use-case';
import { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';
import { ListLedgerUseCase } from '@/modules/wallet/application/list-ledger.use-case';
import { GetWalletUseCase } from '@/modules/wallet/application/get-wallet.use-case';
import { WalletQueriesAdapter } from '@/modules/wallet/infrastructure/persistence/wallet-queries.adapter';
import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FINANCIAL_TRANSACTION } from '@/database/database.module';
import type { FinancialTransaction } from '@/shared/interfaces/financial-transaction.interface';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';

export const WALLET_PROVIDERS: Provider[] = [
  ChallengeAuthGuard,
  ReconciliationSignals,
  {
    provide: ReconcileWalletUseCase,
    inject: [DataSource, ReconciliationSignals],
    useFactory: (dataSource: DataSource, signals: ReconciliationSignals) =>
      new ReconcileWalletUseCase(new WalletQueriesAdapter(dataSource), signals),
  },
  {
    provide: ListLedgerUseCase,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) =>
      new ListLedgerUseCase(new WalletQueriesAdapter(dataSource)),
  },
  {
    provide: GetWalletUseCase,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) =>
      new GetWalletUseCase(new WalletQueriesAdapter(dataSource)),
  },
  {
    provide: OpenWalletUseCase,
    inject: [FINANCIAL_TRANSACTION],
    useFactory: (transaction: FinancialTransaction) => new OpenWalletUseCase(transaction),
  },
];
