import { FailureCode } from '@/shared/enums/wager.enum';
import type { DomainError } from '@/shared/errors/domain.error';
import type { PendingReferenceConfig } from '@/config/pending-reference';
import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import type { WagerCommand } from '@/shared/interfaces/wager-command.interface';
import { canonicalHash } from '@/shared/utils/hash.util';

export function matchesWagerPayload(transaction: WagerTransaction, command: WagerCommand): boolean {
  if (transaction.matchesPayload(command.payloadHash)) return true;
  // Older hashes could contain uppercase UUIDs. PostgreSQL retained their lowercase
  // values, so compare the saved business data without rewriting immutable history.
  return (
    canonicalHash({
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      ...(transaction.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    }) === command.payloadHash
  );
}

export function businessFailureCode(error: DomainError): FailureCode {
  const code = Object.values(FailureCode).find((code) => code === error.code);
  if (code === undefined) throw error;
  return code;
}
export function nextReferenceAttempt(
  at: Date,
  attempts: number,
  config: PendingReferenceConfig,
): Date {
  const delay = Math.min(
    config.PENDING_REFERENCE_RETRY_MAX_MS,
    config.PENDING_REFERENCE_RETRY_BASE_MS * 2 ** attempts,
  );
  return new Date(at.getTime() + delay);
}
