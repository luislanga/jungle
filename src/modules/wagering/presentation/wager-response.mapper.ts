import { HttpStatus } from '@nestjs/common';
import { WagerTransactionStatus } from '@/shared/enums/wager.enum';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';

const WAGER_HTTP_STATUS: Record<WagerTransactionStatus, HttpStatus> = {
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function wagerHttpStatus(status: WagerTransactionStatus): HttpStatus {
  return WAGER_HTTP_STATUS[status];
}

export function wagerResponse(stored: StoredWager) {
  const transaction = stored.transaction;
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    balance: stored.resultBalance?.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt ? { processedAt: transaction.processedAt.toISOString() } : {}),
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
  };
}
