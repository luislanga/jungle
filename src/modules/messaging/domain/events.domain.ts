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
function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}
function assertStatus(tx: WagerTransaction, status: WagerTransactionStatus): void {
  if (tx.status !== status) throw new DomainError(DOMAIN_ERRORS.EVENT_TRANSACTION_STATE_MISMATCH);
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...metadata(tx.walletId, ctx),
      data: { ...transactionData(tx), balance: balance.toJSON() },
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

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    if (!tx.failureCode) throw new DomainError(DOMAIN_ERRORS.MISSING_FAILURE_CODE);
    return new WagerTransactionRejected({
      ...metadata(tx.walletId, ctx),
      data: {
        ...transactionData(tx),
        failureCode: tx.failureCode,
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

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    if (!tx.referenceExternalTransactionId)
      throw new DomainError(DOMAIN_ERRORS.PENDING_EVENT_REFERENCE_REQUIRED);
    return new WagerTransactionPendingReference({
      ...metadata(tx.walletId, ctx),
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
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
