import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import type { Wallet } from '@/modules/wallet/domain/wallet.domain';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WagerTransactionStatus } from '@/shared/enums/wager.enum';
import { DomainError } from '@/shared/errors/domain.error';
import { IntegrationEvent } from '@/shared/domain/integration-event.domain';
import type { Money } from '@/shared/domain/money.domain';
import type {
  EventContext,
  IntegrationEventProps,
  TransactionEventData,
  WagerTransactionProcessedData,
  WagerTransactionRejectedData,
  WagerTransactionPendingReferenceData,
  WalletBalanceChangedData,
} from '@/shared/interfaces/event.interface';

function metadata(aggregateId: string, ctx: EventContext) {
  return {
    eventId: ctx.eventId ?? crypto.randomUUID(),
    aggregateId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
    occurredAt: ctx.occurredAt ?? new Date(),
  };
}
function transactionData(transaction: WagerTransaction): TransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
function assertStatus(transaction: WagerTransaction, status: WagerTransactionStatus): void {
  if (transaction.status !== status)
    throw new DomainError(DOMAIN_ERRORS.EVENT_TRANSACTION_STATE_MISMATCH);
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    balance: Money,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...metadata(transaction.walletId, ctx),
      data: { ...transactionData(transaction), balance: balance.toJSON() },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    balance: Money,
    ctx: EventContext,
  ): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    if (!transaction.failureCode) throw new DomainError(DOMAIN_ERRORS.MISSING_FAILURE_CODE);
    return new WagerTransactionRejected({
      ...metadata(transaction.walletId, ctx),
      data: {
        ...transactionData(transaction),
        failureCode: transaction.failureCode,
        balance: balance.toJSON(),
      },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
    Object.freeze(this);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    if (!transaction.referenceExternalTransactionId)
      throw new DomainError(DOMAIN_ERRORS.PENDING_EVENT_REFERENCE_REQUIRED);
    return new WagerTransactionPendingReference({
      ...metadata(transaction.walletId, ctx),
      data: {
        ...transactionData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (
      wallet.id !== entry.walletId ||
      !entry.money.isPositive() ||
      !entry.isBalanced() ||
      !wallet.balance.equals(entry.balanceAfter)
    ) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_BALANCE_EVENT);
    }
    return new WalletBalanceChanged({
      ...metadata(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
