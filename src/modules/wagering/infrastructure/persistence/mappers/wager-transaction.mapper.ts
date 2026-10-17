import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WagerTransactionEntity } from '@/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { Money } from '@/shared/domain/money.domain';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/enums/wager.enum';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';

export class WagerTransactionMapper {
  static toDomain(row: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      status: row.status as WagerTransactionStatus,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      createdAt: row.createdAt,
      ...(row.referenceExternalTransactionId === null
        ? {}
        : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
      ...(row.referenceTransactionId === null
        ? {}
        : { referenceTransactionId: row.referenceTransactionId }),
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode as FailureCode }),
      ...(row.processedAt === null ? {} : { processedAt: row.processedAt }),
    });
  }

  static toStored(row: WagerTransactionEntity): StoredWager {
    return {
      transaction: this.toDomain(row),
      resultBalance:
        row.resultBalance === null
          ? null
          : Money.from({ amount: row.resultBalance, currency: row.currency }),
    };
  }

  static toPersistence(
    transaction: WagerTransaction,
    resultBalance: Money | null,
  ): WagerTransactionEntity {
    return Object.assign(new WagerTransactionEntity(), {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      amount: transaction.money.toString(),
      currency: transaction.money.currency,
      createdAt: transaction.createdAt,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      processedAt: transaction.processedAt ?? null,
      resultBalance: resultBalance?.toString() ?? null,
    });
  }
}
