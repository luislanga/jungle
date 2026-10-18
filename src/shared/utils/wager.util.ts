import { WagerTransactionKind } from '@/shared/enums/wager.enum';

export function requiresWagerReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

export function allowsZeroWagerAmount(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Loss;
}

export function isSelfReference(externalId: string, referenceId?: string): boolean {
  return referenceId === externalId;
}
