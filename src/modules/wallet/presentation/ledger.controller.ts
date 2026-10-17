import { ENDPOINTS, WALLET_ROUTES } from '@/shared/consts/endpoints.constant';
import { WALLET_ID_SCHEMA } from '@/modules/wallet/presentation/wallet.schema';
import { LEDGER_QUERY_SCHEMA } from '@/modules/wallet/presentation/ledger.schema';
import { ledgerResponse } from '@/modules/wallet/presentation/ledger-response.mapper';
import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ListLedgerUseCase } from '@/modules/wallet/application/list-ledger.use-case';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';

@Controller(ENDPOINTS.WALLETS)
@UseGuards(ChallengeAuthGuard)
export class LedgerController {
  constructor(@Inject(ListLedgerUseCase) private readonly listLedger: ListLedgerUseCase) {}

  @Get(WALLET_ROUTES.WALLET_LEDGER)
  async list(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { limit, cursor } = LEDGER_QUERY_SCHEMA.parse(query);
    return ledgerResponse(
      await this.listLedger.execute(WALLET_ID_SCHEMA.parse(walletId), limit, cursor),
    );
  }
}
