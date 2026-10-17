import { GetWalletUseCase } from '@/modules/wallet/application/get-wallet.use-case';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/database/database.module';
import type { DatabaseConfig } from '@/config/database';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';

export const WALLET_PROVIDERS: Provider[] = [
  ChallengeAuthGuard,
  {
    provide: GetWalletUseCase,
    inject: [DataSource],
    useFactory: (dataSource: DataSource) =>
      new GetWalletUseCase(new WalletRepository(dataSource.manager)),
  },
  {
    provide: OpenWalletUseCase,
    inject: [DataSource, DATABASE_CONFIG],
    useFactory: (dataSource: DataSource, config: DatabaseConfig) =>
      new OpenWalletUseCase(dataSource, config),
  },
];
