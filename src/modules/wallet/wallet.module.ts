import { LedgerController } from '@/modules/wallet/presentation/ledger.controller';
import { Module } from '@nestjs/common';
import { WalletController } from '@/modules/wallet/presentation/wallet.controller';
import { WALLET_PROVIDERS } from '@/modules/wallet/wallet.providers';

@Module({
  controllers: [WalletController, LedgerController],
  providers: [...WALLET_PROVIDERS],
})
export class WalletModule {}
