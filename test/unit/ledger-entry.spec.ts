import { expect, test } from 'bun:test';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { Money } from '@/shared/domain/money.domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const state = () => ({
  id: 'entry',
  walletId: 'w',
  transactionId: 't',
  direction: LedgerDirection.Debit,
  money: brl('80'),
  balanceBefore: brl('100'),
  balanceAfter: brl('20'),
  createdAt: new Date('2026-01-01Z'),
});

test('ledger validates debit and credit arithmetic, including opening credit', () => {
  expect(WalletLedgerEntry.create(state()).isBalanced()).toBe(true);
  expect(
    WalletLedgerEntry.create({
      ...state(),
      direction: LedgerDirection.Credit,
      balanceBefore: brl('0'),
      balanceAfter: brl('80'),
    }).isBalanced(),
  ).toBe(true);
  expect(() => WalletLedgerEntry.create({ ...state(), balanceAfter: brl('21') })).toThrow();
  expect(() => WalletLedgerEntry.create({ ...state(), money: brl('0') })).toThrow();
  expect(() => WalletLedgerEntry.create({ ...state(), money: brl('1').negate() })).toThrow();
  expect(() => WalletLedgerEntry.create({ ...state(), balanceAfter: brl('1').negate() })).toThrow();
  expect(() =>
    WalletLedgerEntry.create({ ...state(), money: Money.from({ amount: '80', currency: 'USD' }) }),
  ).toThrow('currencies');
});

test('ledger state is immutable; rehydrate does not replay creation validation', () => {
  const persisted = state();
  const entry = WalletLedgerEntry.rehydrate(persisted);
  persisted.createdAt.setFullYear(2000);
  persisted.balanceAfter = brl('999');
  entry.createdAt.setFullYear(2001);
  expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  expect(entry.balanceAfter.toString()).toBe('20.00');
  expect(Object.isFrozen(entry)).toBe(true);
  expect(WalletLedgerEntry.rehydrate({ ...state(), balanceAfter: brl('21') }).isBalanced()).toBe(
    false,
  );
});
