import type { IntegrationEvent } from '@/shared/domain/integration-event.domain';
import type { EventContext } from '@/shared/interfaces/event.interface';
import type {
  FinancialTransaction,
  FinancialRepositories,
} from '@/shared/interfaces/financial-transaction.interface';
import {
  startProcessingTimer,
  recordMetrics,
  recordWagerResult,
  OUTCOME_COUNT,
} from '@/shared/infrastructure/metrics/metrics';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';
import type { PendingReferenceConfig } from '@/config/pending-reference';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '@/modules/messaging/domain/events.domain';
import { ReferenceValidationStatus, WagerTransactionStatus } from '@/shared/enums/wager.enum';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { DomainError } from '@/shared/errors/domain.error';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS, DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { Money } from '@/shared/domain/money.domain';
import {
  businessFailureCode,
  nextReferenceAttempt,
  matchesWagerPayload,
} from '@/modules/wagering/application/transaction.policy';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';
import type {
  WagerCommand,
  WagerProcessingContext,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transaction: FinancialTransaction,
    private readonly pendingConfig: PendingReferenceConfig,
  ) {}

  async execute(
    command: WagerCommand,
    context: WagerProcessingContext,
  ): Promise<WagerProcessingResult> {
    const stopTimer = startProcessingTimer('submit');
    try {
      // HTTP and SQS use this same path. These repositories share one database
      // transaction, so a failed commit leaves no wallet, ledger, Inbox or Outbox changes.
      const result = await this.transaction(async (repositories) => {
        const wagers = repositories.wagers;
        let stored = await wagers.findByKey(command.idempotencyKey, true);
        let created = false;
        if (!stored) {
          const wallet = await repositories.wallets.findById(command.data.walletId);
          if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);
          if (
            wallet.playerId !== command.data.playerId ||
            wallet.currency !== command.data.money.currency
          ) {
            throw new ApplicationError(APPLICATION_ERRORS.INVALID_WALLET_CONTEXT);
          }
          const { referenceExternalTransactionId, ...businessData } = command.data;
          const transaction = WagerTransaction.create({
            ...businessData,
            ...(referenceExternalTransactionId === undefined
              ? {}
              : { referenceExternalTransactionId }),
            id: crypto.randomUUID(),
            idempotencyKey: command.idempotencyKey,
            payloadHash: command.payloadHash,
            money: Money.from(command.data.money),
          });
          await wagers.insertIfAbsent(transaction);
          stored = await wagers.findByKey(command.idempotencyKey, true);
          if (!stored) throw new ApplicationError(APPLICATION_ERRORS.EXTERNAL_TRANSACTION_CONFLICT);
          created = stored.transaction.id === transaction.id;
        }
        if (!matchesWagerPayload(stored.transaction, command))
          throw new ApplicationError(APPLICATION_ERRORS.IDEMPOTENCY_CONFLICT);
        const inbox = context.inbox
          ? await repositories.inbox.receive(
              InboxMessage.receive({
                ...context.inbox,
                payloadHash: stored.transaction.payloadHash,
              }),
            )
          : undefined;
        const result = created
          ? await this.apply(repositories, stored.transaction, context)
          : this.result(stored, true);
        if (inbox) {
          inbox.markProcessed(new Date());
          await repositories.inbox.save(inbox);
        }
        return result;
      });
      recordWagerResult(result);
      writeLog(result.idempotentReplay ? 'wager_replayed' : 'wager_outcome', {
        ...context,
        transactionId: result.transactionId,
        walletId: command.data.walletId,
        providerId: command.data.providerId,
        messageId: context.inbox?.messageId,
        status: result.status,
        failureCode: result.failureCode,
      });
      return result;
    } finally {
      stopTimer();
    }
  }

  async resume(
    transactionId: string,
    token: string,
    context: WagerProcessingContext,
  ): Promise<WagerProcessingResult> {
    const stopTimer = startProcessingTimer('resume');
    try {
      // The resolver claims work in a separate, committed transaction, then follows
      // the same business-row -> wallet lock order as normal ingress.
      const outcome = await this.transaction(async (repositories) => {
        const stored = await repositories.wagers.findById(transactionId, true);
        if (!stored) throw new ApplicationError(APPLICATION_ERRORS.STALE_CLAIM);
        const work = repositories.pending;
        const claim = await work.findClaim(transactionId, token);
        if (!claim || stored.transaction.status !== WagerTransactionStatus.PendingReference)
          throw new ApplicationError(APPLICATION_ERRORS.STALE_CLAIM);
        // Demo TTL and evaluation limits are independent and configurable. Production
        // settings must account for provider delays and the incident recovery window.
        const expired =
          claim.expiresAt.getTime() <= Date.now() ||
          claim.attempts + 1 >= this.pendingConfig.PENDING_REFERENCE_MAX_ATTEMPTS;
        const result = await this.apply(
          repositories,
          stored.transaction,
          context,
          expired
        );
        const valid =
          result.status === WagerTransactionStatus.PendingReference
            ? await work.scheduleRetry(
                transactionId,
                token,
                nextReferenceAttempt(new Date(), claim.attempts + 1, this.pendingConfig),
              )
            : await work.complete(transactionId, token);
        if (!valid) throw new ApplicationError(APPLICATION_ERRORS.STALE_CLAIM);
        return {
          result,
          walletId: stored.transaction.walletId,
          providerId: stored.transaction.providerId,
        };
      });
      if (outcome.result.status !== WagerTransactionStatus.PendingReference)
        recordMetrics(() => OUTCOME_COUNT.inc({ status: outcome.result.status }));
      writeLog('wager_reference_resumed', {
        ...context,
        transactionId,
        walletId: outcome.walletId,
        providerId: outcome.providerId,
        status: outcome.result.status,
        failureCode: outcome.result.failureCode,
      });
      return outcome.result;
    } finally {
      stopTimer();
    }
  }

  private result(stored: StoredWager, replay: boolean): WagerProcessingResult {
    if (!stored.resultBalance) throw new Error('Persisted wager has no recorded outcome balance');
    return {
      transactionId: stored.transaction.id,
      status: stored.transaction.status,
      balance: stored.resultBalance.toJSON(),
      idempotentReplay: replay,
      ...(stored.transaction.failureCode ? { failureCode: stored.transaction.failureCode } : {}),
    };
  }

  private async apply(
    repositories: FinancialRepositories,
    transaction: WagerTransaction,
    context: WagerProcessingContext,
    expired = false,
  ): Promise<WagerProcessingResult> {
    const wallets = repositories.wallets,
      wagers = repositories.wagers;
    const wallet = await wallets.findById(transaction.walletId, true);
    if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);
    const before = wallet.balance,
      at = new Date();
    const wasPending = transaction.status === WagerTransactionStatus.PendingReference;
    const reference = transaction.referenceExternalTransactionId
      ? (
          await wagers.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          )
        )?.transaction
      : undefined;
    let direction: LedgerDirection | undefined;
    let pendingReference = false;
    try {
      if (expired) throw new DomainError(DOMAIN_ERRORS.REFERENCE_NOT_FOUND_EXPIRED);
      const reversals = reference ? await wagers.processedReversalKinds(reference.id) : [];
      // README 7 accepts WIN both with and without a BET reference. An eligible
      // supplied BET and an unreferenced WIN process now; unavailable references wait.
      pendingReference =
        transaction.validateReference(reference, reversals) ===
        ReferenceValidationStatus.PendingReference;
      if (!pendingReference) {
        direction = transaction.ledgerDirectionFor(reference);
        transaction.assertSufficientBalance(before, direction);
        if (direction === LedgerDirection.Debit) wallet.debit(transaction.money, at);
        if (direction === LedgerDirection.Credit) wallet.credit(transaction.money, at);
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      transaction.reject(businessFailureCode(error));
    }
    let entry: WalletLedgerEntry | undefined;
    if (pendingReference) {
      transaction.markPendingReference();
    } else if (transaction.status !== WagerTransactionStatus.Rejected) {
      // A broken ledger invariant is a programming error: roll back rather than
      // converting it into a rejected wager after changing the in-memory wallet.
      if (direction !== undefined && !wallet.balance.equals(before)) {
        entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money: transaction.money,
          balanceBefore: before,
          balanceAfter: wallet.balance,
          createdAt: at,
        });
      }
      transaction.markProcessed(reference?.id, at);
    }
    await wagers.save(transaction, wallet.balance);
    if (entry) {
      await repositories.ledger.insert(entry);
      await wallets.save(wallet);
    }
    const outbox = repositories.outbox;
    const eventContext = {
      ...context,
      occurredAt: at,
      eventId: crypto.randomUUID(),
    };
    if (transaction.status === WagerTransactionStatus.PendingReference && !wasPending) {
      await repositories.pending.schedule(
        transaction.id,
        new Date(at.getTime() + this.pendingConfig.PENDING_REFERENCE_TTL_MS),
        nextReferenceAttempt(at, 0, this.pendingConfig),
      );
    }
    if (!wasPending || transaction.status !== WagerTransactionStatus.PendingReference) {
      await outbox.enqueue(
        OutboxMessage.enqueue(this.outcomeEvent(transaction, wallet.balance, eventContext)),
      );
    }
    if (entry)
      await outbox.enqueue(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            ...eventContext,
            eventId: crypto.randomUUID(),
          }),
        ),
      );
    return this.result({ transaction, resultBalance: wallet.balance }, false);
  }

  private outcomeEvent(
    transaction: WagerTransaction,
    balance: Money,
    context: EventContext,
  ): IntegrationEvent<unknown> {
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        return WagerTransactionProcessed.from(transaction, balance, context);
      case WagerTransactionStatus.Rejected:
        return WagerTransactionRejected.from(transaction, balance, context);
      case WagerTransactionStatus.PendingReference:
        return WagerTransactionPendingReference.from(transaction, context);
      default:
        throw new DomainError(DOMAIN_ERRORS.INVALID_TRANSACTION_STATE);
    }
  }
}
