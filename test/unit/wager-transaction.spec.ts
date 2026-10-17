import { expect, test } from 'bun:test';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import {
  FailureCode,
  ReferenceValidationStatus,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';
import type { CreateWagerTransactionProps } from '@/shared/interfaces/wager.interface';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { DomainError } from '@/shared/errors/domain.error';
import { Money } from '@/shared/domain/money.domain';

const brl = (amount = '25') => Money.from({ amount, currency: 'BRL' });
const props = (kind = Kind.Bet): CreateWagerTransactionProps => ({
  id: crypto.randomUUID(),
  providerId: 'provider',
  externalTransactionId: crypto.randomUUID(),
  idempotencyKey: 'key',
  payloadHash: 'hash',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind,
  money: brl(),
});
function processed(kind = Kind.Bet, overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.rehydrate({
    ...props(kind),
    ...overrides,
    status: Status.Processed,
    createdAt: new Date(),
  });
}
function dependent(kind: Kind, reference: WagerTransaction) {
  return WagerTransaction.create({
    ...props(kind),
    referenceExternalTransactionId: reference.externalTransactionId,
  });
}
function expectCode(work: () => unknown, code: DomainError['code']) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
  'creates %s pending and applies the approved zero/negative policy',
  (kind) => {
    const input = {
      ...props(kind),
      ...([Kind.Refund, Kind.Rollback].includes(kind)
        ? { referenceExternalTransactionId: 'reference' }
        : {}),
    };
    expect(WagerTransaction.create(input).status).toBe(Status.Pending);
    if (kind === Kind.Loss)
      expect(WagerTransaction.create({ ...input, money: brl('0') }).affectsBalance()).toBe(false);
    else expectCode(() => WagerTransaction.create({ ...input, money: brl('0') }), 'INVALID_AMOUNT');
    expectCode(
      () => WagerTransaction.create({ ...input, money: brl().negate() }),
      'INVALID_AMOUNT',
    );
  },
);

test('OPENING is internal only and requires a positive amount', () => {
  expectCode(() => WagerTransaction.create(props(Kind.Opening)), 'INVALID_TRANSACTION_KIND');
  expect(WagerTransaction.opening(props()).kind).toBe(Kind.Opening);
  expectCode(() => WagerTransaction.opening({ ...props(), money: brl('0') }), 'INVALID_AMOUNT');
});

test.each([Kind.Refund, Kind.Rollback])(
  '%s requires a reference and rejects self references',
  (kind) => {
    expectCode(() => WagerTransaction.create(props(kind)), 'REFERENCE_REQUIRED');
    const input = props(kind);
    expectCode(
      () =>
        WagerTransaction.create({
          ...input,
          referenceExternalTransactionId: input.externalTransactionId,
        }),
      'INVALID_REFERENCE',
    );
  },
);

test('WIN supports both immediate payload shapes and defers an unavailable supplied reference', () => {
  const bet = processed();
  const without = WagerTransaction.create(props(Kind.Win));
  const withReference = dependent(Kind.Win, bet);
  expect(without.validateReference()).toBe(ReferenceValidationStatus.Ready);
  expect(withReference.validateReference(bet)).toBe(ReferenceValidationStatus.Ready);
  expect(withReference.validateReference()).toBe(ReferenceValidationStatus.PendingReference);
  expect(withReference.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  const pending = WagerTransaction.create({
    ...props(),
    externalTransactionId: bet.externalTransactionId,
  });
  expect(withReference.validateReference(pending)).toBe(ReferenceValidationStatus.PendingReference);
  pending.markPendingReference();
  expect(withReference.validateReference(pending)).toBe(ReferenceValidationStatus.PendingReference);
});

test('reference validates every required context field but does not add a game restriction', () => {
  const bet = processed();
  const refund = dependent(Kind.Refund, bet);
  for (const field of [
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
  ] as const) {
    const wrong = processed(Kind.Bet, {
      externalTransactionId: bet.externalTransactionId,
      [field]: 'different',
    });
    expectCode(() => refund.validateReference(wrong), FailureCode.ReferenceContextMismatch);
  }
  expectCode(
    () =>
      refund.validateReference(
        processed(Kind.Bet, {
          externalTransactionId: bet.externalTransactionId,
          money: Money.from({ amount: '25', currency: 'USD' }),
        }),
      ),
    FailureCode.ReferenceContextMismatch,
  );
  expect(
    refund.validateReference(
      processed(Kind.Bet, {
        externalTransactionId: bet.externalTransactionId,
        gameId: 'another-game',
      }),
    ),
  ).toBe(ReferenceValidationStatus.Ready);
  expectCode(
    () =>
      refund.validateReference(
        processed(Kind.Bet, { externalTransactionId: bet.externalTransactionId, money: brl('24') }),
      ),
    FailureCode.ReferenceAmountMismatch,
  );
});

test('invalid terminal states and reference kinds are rejected', () => {
  for (const status of [Status.Rejected, Status.Failed]) {
    const state = {
      ...props(),
      status,
      createdAt: new Date(),
    };
    const ref = WagerTransaction.rehydrate(state);
    expectCode(
      () => dependent(Kind.Refund, ref).validateReference(ref),
      FailureCode.ReferenceNotProcessed,
    );
  }
  for (const kind of [Kind.Opening, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
    const ref = processed(kind);
    expectCode(
      () => dependent(Kind.Refund, ref).validateReference(ref),
      FailureCode.InvalidReferenceKind,
    );
    expectCode(
      () => dependent(Kind.Win, ref).validateReference(ref),
      FailureCode.InvalidReferenceKind,
    );
  }
  for (const kind of [Kind.Opening, Kind.Loss, Kind.Rollback]) {
    const ref = processed(kind);
    expectCode(
      () => dependent(Kind.Rollback, ref).validateReference(ref),
      FailureCode.InvalidReferenceKind,
    );
  }
});

test('each reversal kind is unique independently; rollback reverses all allowed directions', () => {
  const bet = processed();
  expect(dependent(Kind.Refund, bet).validateReference(bet, [Kind.Rollback])).toBe(
    ReferenceValidationStatus.Ready,
  );
  expect(dependent(Kind.Rollback, bet).validateReference(bet, [Kind.Refund])).toBe(
    ReferenceValidationStatus.Ready,
  );
  for (const kind of [Kind.Refund, Kind.Rollback])
    expectCode(
      () => dependent(kind, bet).validateReference(bet, [kind]),
      FailureCode.ReferenceAlreadyReversed,
    );
  for (const kind of [Kind.Bet, Kind.Win, Kind.Refund]) {
    const ref = processed(kind);
    const rollback = dependent(Kind.Rollback, ref);
    expect(rollback.validateReference(ref)).toBe(ReferenceValidationStatus.Ready);
    expect(rollback.ledgerDirectionFor(ref)).toBe(
      kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
    );
  }
});

test('ordinary bet and reversal insufficiency have distinct machine-readable codes', () => {
  expectCode(
    () => WagerTransaction.create(props()).assertSufficientBalance(brl('0')),
    FailureCode.InsufficientFunds,
  );
  const win = processed(Kind.Win);
  expectCode(
    () => dependent(Kind.Rollback, win).assertSufficientBalance(brl('0'), win),
    FailureCode.ReversalInsufficientFunds,
  );
  WagerTransaction.create(props()).assertSufficientBalance(brl());
  expect(WagerTransaction.create(props(Kind.Loss)).ledgerDirectionFor()).toBeUndefined();
});

test.each([Status.Pending, Status.PendingReference])(
  '%s can enter every terminal state, which then rejects every transition',
  (status) => {
    for (const terminal of [Status.Processed, Status.Rejected, Status.Failed]) {
      const transaction = WagerTransaction.rehydrate({
        ...props(),
        createdAt: new Date(),
        status,
      });
      const id = transaction.id;
      transaction.markPendingReference();
      if (terminal === Status.Processed) transaction.markProcessed(undefined, new Date());
      if (terminal === Status.Rejected) transaction.reject(FailureCode.InsufficientFunds);
      if (terminal === Status.Failed) transaction.fail(FailureCode.PermanentProcessingFailure);
      expect(transaction.status).toBe(terminal);
      expect(transaction.id).toBe(id);
      for (const change of [
        () => transaction.markPendingReference(),
        () => transaction.markProcessed(undefined, new Date()),
        () => transaction.reject(FailureCode.InsufficientFunds),
        () => transaction.fail(FailureCode.PermanentProcessingFailure),
      ]) {
        expectCode(change, FailureCode.InvalidTransactionState);
      }
    }
  },
);

test('rehydration preserves state without replay and timestamps cannot be mutated externally', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const transaction = WagerTransaction.rehydrate({
    ...props(),
    status: Status.Processed,
    createdAt: at,
    processedAt: at,
    referenceTransactionId: 'ref',
  });
  at.setFullYear(2000);
  transaction.createdAt.setFullYear(2001);
  transaction.processedAt?.setFullYear(2002);
  expect(transaction.createdAt.getUTCFullYear()).toBe(2026);
  expect(transaction.processedAt?.getUTCFullYear()).toBe(2026);
  expect(transaction.referenceTransactionId).toBe('ref');
  expect(transaction.matchesPayload('hash')).toBe(true);
  expect(transaction.matchesPayload('different')).toBe(false);
});
