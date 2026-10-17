import { GetWalletUseCase } from '@/modules/wallet/application/get-wallet.use-case';
import { OPEN_WALLET_SCHEMA, WALLET_ID_SCHEMA } from '@/modules/wallet/presentation/wallet.schema';
import { walletResponse } from '@/modules/wallet/presentation/wallet-response.mapper';
import { ENDPOINTS, WALLET_ROUTES } from '@/shared/consts/endpoints.constant';
import { Body, Controller, Get, Req, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { Money } from '@/shared/domain/money.domain';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';
import type { HttpRequestContext } from '@/shared/interfaces/http.interface';

@Controller(ENDPOINTS.WALLETS)
@UseGuards(ChallengeAuthGuard)
export class WalletController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
  ) {}

  @Post()
  async open(@Body() body: unknown, @Req() request: HttpRequestContext) {
    // TODO: fazer um wrapper do zod com o pipe do Nest para validação nos controllers mantendo o schema para validação por chamada do worker SQS posteriormente
    const input = OPEN_WALLET_SCHEMA.parse(body);
    const wallet = await this.openWallet.execute(
      { playerId: input.playerId, initialBalance: Money.from(input.initialBalance) },
      // If not provided in headers, CorrelationMiddleware provided in app.module will generate an uuid for correlationId
      { correlationId: request.correlationId },
    );
    return walletResponse(wallet);
  }

  @Get(WALLET_ROUTES.WALLET_BY_ID)
  async find(@Param('walletId') id: string) {
    return walletResponse(await this.getWallet.execute(WALLET_ID_SCHEMA.parse(id)));
  }
}
