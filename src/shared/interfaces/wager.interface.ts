import type { Money } from '@/shared/domain/money.domain';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/enums/wager.enum';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}
export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'createdAt' | 'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
>;

export type OpeningWagerTransactionProps = Omit<
  CreateWagerTransactionProps,
  'kind' | 'referenceExternalTransactionId'
>;
