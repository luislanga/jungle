import type { DataSource, EntityManager } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import {
  readPendingReferenceConfig,
  type PendingReferenceConfig,
} from '@/config/pending-reference';
import { withTransaction } from '@/database/transaction';
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
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import { WalletLedgerEntryRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet-ledger-entry.repository';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { InboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/inbox-message.repository';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import { ReferenceValidationStatus, WagerTransactionStatus } from '@/shared/enums/wager.enum';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { DomainError } from '@/shared/errors/domain.error';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS, DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { Money } from '@/shared/domain/money.domain';
import {
  businessFailureCode,
  nextReferenceAttempt,
} from '@/modules/wagering/application/transaction.policy';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';
import type {
  WagerCommand,
  WagerProcessingContext,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: DatabaseConfig,
    private readonly pendingConfig: PendingReferenceConfig = readPendingReferenceConfig(),
  ) {}

  async execute(
    command: WagerCommand,
    context: WagerProcessingContext,
  ): Promise<WagerProcessingResult> {
    // HTTP and SQS enter the same transaction. Every write uses this manager, including
    // Inbox and Outbox; a failed commit must not leave a debit or event behind.
    return withTransaction(this.dataSource, this.config, async (manager) => {
      const wagers = new WagerTransactionRepository(manager);
      let stored = await wagers.findByKey(command.idempotencyKey, true);
      let created = false;
      if (!stored) {
        const wallet = await new WalletRepository(manager).findById(command.data.walletId);
        if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);
        if (
          wallet.playerId !== command.data.playerId ||
          wallet.currency !== command.data.money.currency
        ) {
          throw new ApplicationError(APPLICATION_ERRORS.INVALID_WALLET_CONTEXT);
        }
        const { referenceExternalTransactionId, ...businessData } = command.data;
        const tx = WagerTransaction.create({
          ...businessData,
          ...(referenceExternalTransactionId === undefined
            ? {}
            : { referenceExternalTransactionId }),
          id: crypto.randomUUID(),
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          money: Money.from(command.data.money),
        });
        await wagers.insertIfAbsent(tx);
        stored = await wagers.findByKey(command.idempotencyKey, true);
        if (!stored) throw new ApplicationError(APPLICATION_ERRORS.EXTERNAL_TRANSACTION_CONFLICT);
        created = stored.transaction.id === tx.id;
      }
      if (!stored.transaction.matchesPayload(command.payloadHash))
        throw new ApplicationError(APPLICATION_ERRORS.IDEMPOTENCY_CONFLICT);
      const inbox = context.inbox
        ? await new InboxMessageRepository(manager).receive(
            InboxMessage.receive({ ...context.inbox, payloadHash: command.payloadHash }),
          )
        : undefined;
      if (!created) {
        if (inbox) {
          inbox.markProcessed(new Date());
          await new InboxMessageRepository(manager).save(inbox);
        }
        return this.result(stored, true);
      }
      const result = await this.apply(manager, stored.transaction, context);
      if (inbox) {
        inbox.markProcessed(new Date());
        await new InboxMessageRepository(manager).save(inbox);
      }
      return result;
    });
  }

  async resume(
    transactionId: string,
    token: string,
    context: WagerProcessingContext,
  ): Promise<WagerProcessingResult> {
    // The resolver claims work in a separate, committed transaction, then follows
    // the same business-row -> wallet lock order as normal ingress.
    return withTransaction(this.dataSource, this.config, async (manager) => {
      const stored = await new WagerTransactionRepository(manager).findById(transactionId, true);
      if (!stored) throw new ApplicationError(APPLICATION_ERRORS.STALE_CLAIM);
      const work = new PendingReferenceWorkRepository(manager);
      const claim = await work.findClaim(transactionId, token);
      if (!claim || stored.transaction.status !== WagerTransactionStatus.PendingReference)
        throw new ApplicationError(APPLICATION_ERRORS.STALE_CLAIM);
      // Demo TTL and evaluation limits are independent and configurable. Production
      // settings must account for provider delays and the incident recovery window.
      const expired =
        claim.expiresAt.getTime() <= Date.now() ||
        claim.attempts + 1 >= this.pendingConfig.PENDING_REFERENCE_MAX_ATTEMPTS;
      const result = await this.apply(
        manager,
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
      return result;
    });
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
    manager: EntityManager,
    tx: WagerTransaction,
    context: WagerProcessingContext,
    expired = false,
  ): Promise<WagerProcessingResult> {
    const wallets = new WalletRepository(manager),
      wagers = new WagerTransactionRepository(manager);
    const wallet = await wallets.findById(tx.walletId, true);
    if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);
    const before = wallet.balance,
      at = new Date();
    const wasPending = tx.status === WagerTransactionStatus.PendingReference;
    const reference = tx.referenceExternalTransactionId
      ? (await wagers.findByExternalId(tx.providerId, tx.referenceExternalTransactionId))
          ?.transaction
      : undefined;
    let direction: LedgerDirection | undefined;
    let pendingReference = false;
    try {
      if (expired) throw new DomainError(DOMAIN_ERRORS.REFERENCE_NOT_FOUND_EXPIRED);
      const reversals = reference ? await wagers.processedReversalKinds(reference.id) : [];
      // README 7 accepts WIN both with and without a BET reference. An eligible
      // supplied BET and an unreferenced WIN process now; unavailable references wait.
      pendingReference =
        tx.validateReference(reference, reversals) === ReferenceValidationStatus.PendingReference;
      if (!pendingReference) {
        tx.assertSufficientBalance(before, reference);
        direction = tx.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.Debit) wallet.debit(tx.money, at);
        if (direction === LedgerDirection.Credit) wallet.credit(tx.money, at);
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      tx.reject(businessFailureCode(error));
    }
    let entry: WalletLedgerEntry | undefined;
    if (pendingReference) {
      tx.markPendingReference();
    } else if (tx.status !== WagerTransactionStatus.Rejected) {
      // A broken ledger invariant is a programming error: roll back rather than
      // converting it into a rejected wager after changing the in-memory wallet.
      if (direction !== undefined && !wallet.balance.equals(before)) {
        entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: tx.id,
          direction,
          money: tx.money,
          balanceBefore: before,
          balanceAfter: wallet.balance,
          createdAt: at,
        });
      }
      tx.markProcessed(reference?.id, at);
    }
    await wagers.save(tx, wallet.balance);
    if (entry) {
      await new WalletLedgerEntryRepository(manager).insert(entry);
      await wallets.save(wallet);
    }
    const outbox = new OutboxMessageRepository(manager);
    const eventContext = {
      ...context,
      occurredAt: at,
      eventId: crypto.randomUUID(),
    };
    if (tx.status === WagerTransactionStatus.PendingReference && !wasPending) {
      await new PendingReferenceWorkRepository(manager).schedule(
        tx.id,
        new Date(at.getTime() + this.pendingConfig.PENDING_REFERENCE_TTL_MS),
        nextReferenceAttempt(at, 0, this.pendingConfig),
      );
      await outbox.enqueue(
        OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventContext)),
      );
    }
    if (tx.status === WagerTransactionStatus.Processed)
      await outbox.enqueue(
        OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, wallet.balance, eventContext)),
      );
    if (tx.status === WagerTransactionStatus.Rejected)
      await outbox.enqueue(
        OutboxMessage.enqueue(WagerTransactionRejected.from(tx, wallet.balance, eventContext)),
      );
    if (entry)
      await outbox.enqueue(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            ...eventContext,
            eventId: crypto.randomUUID(),
          }),
        ),
      );
    return this.result({ transaction: tx, resultBalance: wallet.balance }, false);
  }
}
