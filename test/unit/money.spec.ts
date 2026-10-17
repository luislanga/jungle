import { describe, expect, test } from 'bun:test';
import { Money } from '@/shared/domain/money.domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test.each([
    'NaN',
    'Infinity',
    '',
    ' ',
    '1e2',
    '1E2',
    '-1',
    '-0',
    '+1',
    '.1',
    '1.',
    '1.001',
    ' 1',
    '1,00',
  ])('rejects invalid input %s', (amount) => {
    expect(() => brl(amount)).toThrow();
  });

  test('rejects numbers even if a caller bypasses TypeScript', () => {
    expect(() => brl(1 as unknown as string)).toThrow();
  });

  test.each(['1', '1.0', '01.00'])('normalizes %s to two places', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
  });

  test('decimal arithmetic is exact and does not mutate its operands', () => {
    const a = brl('0.10');
    const b = brl('0.20');
    expect(a.add(b).toString()).toBe('0.30');
    expect(a.toString()).toBe('0.10');
    expect(b.toString()).toBe('0.20');
    expect(a.add(b)).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    const props = a.toJSON();
    props.amount = '99.00';
    expect(a.toString()).toBe('0.10');
  });

  test('supports signed internal arithmetic without accepting negative input', () => {
    expect(brl('1').subtract(brl('2')).toString()).toBe('-1.00');
    expect(brl('1').negate().isNegative()).toBe(true);
    expect(brl('1').isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
    expect(brl('1').isLessThan(brl('2'))).toBe(true);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
  });

  test('rejects overflow at input and after arithmetic without rounding', () => {
    const max = brl('999999999999999999.99');
    expect(max.toString()).toBe('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(() => brl('1000000000000000000.00')).toThrow('NUMERIC');
    expect(() => max.add(brl('0.01'))).toThrow('NUMERIC');
    expect(() => max.negate().subtract(brl('0.01'))).toThrow('NUMERIC');
  });

  test('validates currency and checks it on every binary operation', () => {
    for (const currency of ['brl', 'ZZZ', '']) expect(() => Money.zero(currency)).toThrow();
    const usd = Money.from({ amount: '1', currency: 'USD' });
    for (const operation of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
      expect(() => brl('1')[operation](usd)).toThrow('currencies');
    }
    expect(usd.currency).toBe('USD');
  });

  test('decimal.js global settings cannot change Money precision', async () => {
    const { Decimal } = await import('decimal.js');
    const previous = Decimal.precision;
    try {
      Decimal.set({ precision: 2 });
      expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(
        '999999999999999999.99',
      );
    } finally {
      Decimal.set({ precision: previous });
    }
  });
});
