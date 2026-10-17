import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import {
  ProviderTransactionController,
  WagerController,
} from '@/modules/wagering/presentation/wager.controller';
import { WAGERING_PROVIDERS } from '@/modules/wagering/wagering.providers';

@Module({
  controllers: [WagerController, ProviderTransactionController],
  providers: [...WAGERING_PROVIDERS],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
