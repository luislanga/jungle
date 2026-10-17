import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import {
  ReferenceValidationStatus,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/shared/enums/wager.enum';
import type { FailureCode } from '@/shared/enums/wager.enum';
import type {
  CreateWagerTransactionProps,
  OpeningWagerTransactionProps,
  WagerTransactionState,
} from '@/shared/interfaces/wager.interface';
import { DomainError } from '@/shared/errors/domain.error';
import type { Money } from '@/shared/domain/money.domain';

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];
const ROLLBACK_REFERENCE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];
const BET_REFERENCE_KINDS: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet];

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionState) {}

  static create(props: CreateWagerTransactionProps, at = new Date()): WagerTransaction {
    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      props.kind === WagerTransactionKind.Opening
    ) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_TRANSACTION_KIND);
    }
    const transaction = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      createdAt: at,
    });
    transaction.assertAmount();
    if (transaction.requiresReference() && !props.referenceExternalTransactionId) {
      throw new DomainError(DOMAIN_ERRORS.REFERENCE_REQUIRED);
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_REFERENCE);
    }
    // README 7 allows WIN with or without a BET reference. A supplied reference
    // is validated when resolved; omitting it is also a valid payload.
    return transaction;
  }

  static opening(props: OpeningWagerTransactionProps, at = new Date()): WagerTransaction {
    const transaction = WagerTransaction.rehydrate({
      ...props,
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Pending,
      createdAt: at,
    });
    transaction.assertAmount();
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      ...(state.processedAt ? { processedAt: new Date(state.processedAt) } : {}),
    });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string {
    return this.state.roundId;
  }

  get gameId(): string {
    return this.state.gameId;
  }

  get kind(): WagerTransactionKind {
    return this.state.kind;
  }

  get money(): Money {
    return this.state.money;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  validateReference(
    reference?: WagerTransaction,
    processedReversalKinds: readonly WagerTransactionKind[] = [],
  ): ReferenceValidationStatus {
    // README 7 permits immediate WIN processing without a reference. When one
    // is supplied, process it immediately only if the referenced BET is eligible.
    if (!this.referenceExternalTransactionId) return ReferenceValidationStatus.Ready;
    if (!reference) return ReferenceValidationStatus.PendingReference;
    if (
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      throw new DomainError(DOMAIN_ERRORS.REFERENCE_CONTEXT_MISMATCH);
    }
    if (!reference.isTerminal()) return ReferenceValidationStatus.PendingReference;
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError(DOMAIN_ERRORS.REFERENCE_NOT_PROCESSED);
    }
    const allowedReferenceKinds =
      this.kind === WagerTransactionKind.Rollback ? ROLLBACK_REFERENCE_KINDS : BET_REFERENCE_KINDS;
    if (!allowedReferenceKinds.includes(reference.kind))
      throw new DomainError(DOMAIN_ERRORS.INVALID_REFERENCE_KIND);
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError(DOMAIN_ERRORS.REFERENCE_AMOUNT_MISMATCH);
    }
    // README §7, rule 4 allows one reversal of each kind. We follow that literal
    // rule for this challenge, even though REFUND plus ROLLBACK can double-credit
    // the original BET. In production we would discuss this with product,
    // finance and the provider before implementing it.
    if (this.requiresReference() && processedReversalKinds.includes(this.kind)) {
      throw new DomainError(DOMAIN_ERRORS.REFERENCE_ALREADY_REVERSED);
    }
    return ReferenceValidationStatus.Ready;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Loss) return undefined;
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference || this.validateReference(reference) !== ReferenceValidationStatus.Ready) {
        throw new DomainError(DOMAIN_ERRORS.REVERSAL_REFERENCE_NOT_PROCESSED);
      }
      return reference.kind === WagerTransactionKind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    return LedgerDirection.Credit;
  }

  assertSufficientBalance(balance: Money, reference?: WagerTransaction): void {
    if (
      this.ledgerDirectionFor(reference) === LedgerDirection.Debit &&
      balance.isLessThan(this.money)
    ) {
      const error =
        this.kind === WagerTransactionKind.Rollback
          ? DOMAIN_ERRORS.REVERSAL_INSUFFICIENT_FUNDS
          : DOMAIN_ERRORS.WAGER_INSUFFICIENT_FUNDS;
      throw new DomainError(error);
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.Processed;
    if (referenceTransactionId !== undefined)
      this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = new Date(at);
  }

  markPendingReference(): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.Rejected;
    this.state.failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertMutable();
    this.state.status = WagerTransactionStatus.Failed;
    this.state.failureCode = code;
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError(DOMAIN_ERRORS.INVALID_TRANSACTION_STATE);
  }

  private assertAmount(): void {
    // README §6.1 rejects negative input but leaves zero wagers unspecified.
    // Our agreed interpretation accepts zero LOSS; all money-moving kinds are positive.
    if (
      this.money.isNegative() ||
      (this.kind !== WagerTransactionKind.Loss && !this.money.isPositive())
    ) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_WAGER_AMOUNT);
    }
  }
}
