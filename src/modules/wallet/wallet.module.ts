import { ReconciliationController } from '@/modules/wallet/presentation/reconciliation.controller';
import { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';
import { LedgerController } from '@/modules/wallet/presentation/ledger.controller';
import { Module } from '@nestjs/common';
import { WalletController } from '@/modules/wallet/presentation/wallet.controller';
import { WALLET_PROVIDERS } from '@/modules/wallet/wallet.providers';

@Module({
  controllers: [WalletController, LedgerController, ReconciliationController],
  providers: [...WALLET_PROVIDERS],
  exports: [ReconciliationSignals],
})
export class WalletModule {}
