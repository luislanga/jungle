import { ENDPOINTS, WALLET_ROUTES } from '@/shared/consts/endpoints.constant';
import { WALLET_ID_SCHEMA } from '@/modules/wallet/presentation/wallet.schema';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ReconcileWalletUseCase } from '@/modules/wallet/application/reconcile-wallet.use-case';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';
import type { HttpRequestContext } from '@/shared/interfaces/http.interface';

@Controller(ENDPOINTS.WALLETS)
@UseGuards(ChallengeAuthGuard)
export class ReconciliationController {
  constructor(@Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase) {}

  @Post(WALLET_ROUTES.WALLET_RECONCILIATION)
  @HttpCode(HttpStatus.OK)
  execute(@Param('walletId') id: string, @Req() request: HttpRequestContext) {
    return this.reconcile.execute(WALLET_ID_SCHEMA.parse(id), {
      correlationId: request.correlationId,
    });
  }
}
