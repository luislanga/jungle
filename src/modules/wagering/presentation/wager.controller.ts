import { ENDPOINTS, WAGER_ROUTES } from '@/shared/consts/endpoints.constant';
import {
  TRANSACTION_ID_SCHEMA,
  EXTERNAL_ID_SCHEMA,
} from '@/modules/wagering/presentation/wager.schema';
import {
  wagerResponse,
  wagerHttpStatus,
} from '@/modules/wagering/presentation/wager-response.mapper';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { parseHttpWager } from '@/modules/wagering/application/contracts/wager-command.contract';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '@/modules/wagering/application/get-wager-transaction.use-case';
import { ChallengeAuthGuard } from '@/shared/presentation/challenge-auth.guard';
import type { HttpRequestContext, HttpStatusResponse } from '@/shared/interfaces/http.interface';

@Controller(ENDPOINTS.WAGERING)
@UseGuards(ChallengeAuthGuard)
export class WagerController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly getWager: GetWagerTransactionUseCase,
  ) {}

  @Post(WAGER_ROUTES.TRANSACTIONS)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() request: HttpRequestContext,
    @Res({ passthrough: true }) response: HttpStatusResponse,
  ) {
    const result = await this.processWager.execute(parseHttpWager(body, key), {
      correlationId: request.correlationId,
    });
    response.status(wagerHttpStatus(result.status));
    return result;
  }

  @Get(WAGER_ROUTES.TRANSACTION_BY_ID)
  async find(@Param('transactionId') transactionId: string) {
    return wagerResponse(await this.getWager.byId(TRANSACTION_ID_SCHEMA.parse(transactionId)));
  }
}

@Controller(ENDPOINTS.PROVIDERS)
@UseGuards(ChallengeAuthGuard)
export class ProviderTransactionController {
  constructor(
    @Inject(GetWagerTransactionUseCase) private readonly getWager: GetWagerTransactionUseCase,
  ) {}

  @Get(WAGER_ROUTES.PROVIDER_TRANSACTION_BY_EXTERNAL_ID)
  async find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return wagerResponse(
      await this.getWager.byExternalId(
        EXTERNAL_ID_SCHEMA.parse(providerId),
        EXTERNAL_ID_SCHEMA.parse(externalTransactionId),
      ),
    );
  }
}
