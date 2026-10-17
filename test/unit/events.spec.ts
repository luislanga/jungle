import { expect, test } from 'bun:test';
import { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import { FailureCode } from '@/shared/enums/wager.enum';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from '@/modules/messaging/domain/events.domain';
import { Money } from '@/shared/domain/money.domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const context = {
  eventId: 'stable-event',
  correlationId: 'correlation',
  occurredAt: at,
};
function transaction(kind = Kind.Loss) {
  return WagerTransaction.create({
    id: 'tx',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind,
    money: brl('25'),
    ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'bet' } : {}),
  });
}

test('processed LOSS has a versioned JSON envelope with exact MoneyProps and no absent causationId', () => {
  const tx = transaction();
  tx.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(tx, brl('100'), context);
  expect(event.toJSON()).toEqual({
    eventId: 'stable-event',
    eventType: 'WagerTransactionProcessed',
    version: 1,
    aggregateId: 'wallet',
    correlationId: 'correlation',
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: {
      transactionId: 'tx',
      providerId: 'provider',
      externalTransactionId: 'external',
      walletId: 'wallet',
      kind: Kind.Loss,
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '100.00', currency: 'BRL' },
    },
  });
  expect(event.data.money).not.toBeInstanceOf(Money);
  expect(event.eventId).toBe('stable-event');
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.data.money)).toBe(true);
  const json = event.toJSON();
  json.data.money.amount = '999';
  event.occurredAt.setFullYear(2000);
  expect(event.data.money.amount).toBe('25.00');
  expect(event.occurredAt.getUTCFullYear()).toBe(2026);
});

test('rejection and pending-reference event types carry their specific reasons', () => {
  const rejected = transaction(Kind.Bet);
  rejected.reject(FailureCode.InsufficientFunds);
  const event = WagerTransactionRejected.from(rejected, brl('0'), {
    ...context,
    causationId: 'incoming-message',
  });
  expect(event.toJSON().eventType).toBe('WagerTransactionRejected');
  expect(event.toJSON().causationId).toBe('incoming-message');
  expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
  const pending = transaction(Kind.Refund);
  pending.markPendingReference();
  const pendingEvent = WagerTransactionPendingReference.from(pending, context);
  expect(pendingEvent.eventType).toBe('WagerTransactionPendingReference');
  expect(pendingEvent.data.referenceExternalTransactionId).toBe('bet');
  expect(() => WagerTransactionProcessed.from(pending, brl('100'), context)).toThrow();
  expect(() => WagerTransactionRejected.from(transaction(), brl('100'), context)).toThrow();
});

test('wallet event represents a real movement and its current version', () => {
  const wallet = Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: brl('100'),
  });
  wallet.debit(brl('25'));
  const state = {
    id: 'entry',
    walletId: wallet.id,
    transactionId: 'tx',
    direction: LedgerDirection.Debit,
    money: brl('25'),
    balanceBefore: brl('100'),
    balanceAfter: brl('75'),
    createdAt: at,
  };
  const event = WalletBalanceChanged.from(wallet, WalletLedgerEntry.create(state), context);
  expect(event.eventType).toBe('WalletBalanceChanged');
  expect(event.version).toBe(1);
  expect(event.data.walletVersion).toBe(2);
  expect(event.data.balanceAfter.amount).toBe('75.00');
  expect(() =>
    WalletBalanceChanged.from(
      wallet,
      WalletLedgerEntry.rehydrate({ ...state, money: brl('0') }),
      context,
    ),
  ).toThrow();
  expect(() =>
    WalletBalanceChanged.from(
      wallet,
      WalletLedgerEntry.rehydrate({ ...state, walletId: 'another-wallet' }),
      context,
    ),
  ).toThrow();
});

test('event timestamps and signed decimal data remain exact', () => {
  const timestamp = new Date(at);
  const tx = transaction();
  tx.markProcessed(undefined, timestamp);
  const event = WagerTransactionProcessed.from(tx, brl('1').negate(), {
    ...context,
    occurredAt: timestamp,
  });
  timestamp.setFullYear(2000);
  expect(event.toJSON().occurredAt).toBe('2026-01-01T00:00:00.000Z');
  expect(event.data.balance.amount).toBe('-1.00');
});
