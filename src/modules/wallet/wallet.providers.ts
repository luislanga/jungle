import { ReconcileWalletUseCase } from '@/modules/wallet/application/reconcile-wallet.use-case';
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
  {
    provide: WalletQueriesAdapter,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) => new WalletQueriesAdapter(dataSource),
  },
  {
    provide: ReconcileWalletUseCase,
    inject: [WalletQueriesAdapter],
    useFactory: (queries: WalletQueriesAdapter) => new ReconcileWalletUseCase(queries),
  },
  {
    provide: ListLedgerUseCase,
    inject: [WalletQueriesAdapter],
    useFactory: (queries: WalletQueriesAdapter) => new ListLedgerUseCase(queries),
  },
  {
    provide: GetWalletUseCase,
    inject: [WalletQueriesAdapter],
    useFactory: (queries: WalletQueriesAdapter) => new GetWalletUseCase(queries),
  },
  {
    provide: OpenWalletUseCase,
    inject: [FINANCIAL_TRANSACTION],
    useFactory: (transaction: FinancialTransaction) => new OpenWalletUseCase(transaction),
  },
];
