import { expect, test } from 'bun:test';
import { Money } from '@/shared/domain/money.domain';
import { Wallet } from '@/modules/wallet/domain/wallet.domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const open = (amount = '100') =>
  Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl(amount) });

test('opening starts at version one, including zero opening', () => {
  expect(open().version).toBe(1);
  expect(open().balance.toString()).toBe('100.00');
  expect(open('0').balance.isZero()).toBe(true);
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1').negate() })).toThrow(
    'negative',
  );
});

test('balance changes increment version; zero movements do not', () => {
  const wallet = open();
  const originalTime = wallet.updatedAt;
  wallet.debit(brl('0'));
  wallet.credit(brl('0'));
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(originalTime);
  wallet.debit(brl('80'));
  wallet.credit(brl('5'));
  expect(wallet.balance.toString()).toBe('25.00');
  expect(wallet.version).toBe(3);
});

test('failed movements leave all wallet state unchanged', () => {
  const wallet = open();
  expect(() => wallet.debit(brl('101'))).toThrow('insufficient');
  expect(() => wallet.debit(brl('1').negate())).toThrow('negative');
  expect(() => wallet.credit(brl('1').negate())).toThrow('negative');
  const usd = Money.from({ amount: '1', currency: 'USD' });
  expect(() => wallet.credit(usd)).toThrow('currencies');
  expect(() => wallet.debit(usd)).toThrow('currencies');
  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(1);
});

test('rehydration preserves persisted version and protects input/output dates', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const state = {
    id: 'w',
    playerId: 'p',
    currency: 'BRL',
    balance: brl('42'),
    version: 9,
    createdAt: at,
    updatedAt: at,
  };
  const wallet = Wallet.rehydrate(state);
  state.balance = brl('99');
  at.setFullYear(2000);
  wallet.createdAt.setFullYear(2001);
  wallet.updatedAt.setFullYear(2002);
  expect(wallet.version).toBe(9);
  expect(wallet.balance.toString()).toBe('42.00');
  expect(wallet.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  const next = new Date('2026-02-01T00:00:00Z');
  wallet.credit(brl('1'), next);
  next.setFullYear(2000);
  expect(wallet.updatedAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
});
