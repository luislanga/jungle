import type { MoneyProps } from '@/shared/interfaces/money.interface';
import type { LedgerDirection } from '@/shared/enums/wallet.enum';
import type { FailureCode, WagerTransactionKind } from '@/shared/enums/wager.enum';

export interface IntegrationEventProps<Data> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Data;
}

export interface EventEnvelope<Data = unknown> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: Data;
}

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  balance: MoneyProps;
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
