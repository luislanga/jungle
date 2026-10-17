import { Decimal } from 'decimal.js';
import { MAX_MONEY_AMOUNT, MONEY_DECIMAL_PLACES } from '@/shared/consts/money.constant';
import type { MoneyProps } from '@/shared/interfaces/money.interface';
import { isSupportedCurrency, isValidAmountFormat } from '@/shared/utils/money.util';
import { DomainError } from '@/shared/errors/domain.error';
import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';

// decimal.js counts significant digits here, not decimal places.
const CALCULATION_PRECISION = 40;

// This gives Money its own decimal.js settings (clone) so other code cannot change how it calculates.
// Calculate with more digits than we store, then reject amounts above the shared money limit.
const MONEY_DECIMAL = Decimal.clone({ precision: CALCULATION_PRECISION });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    // decimal.js abs() ignores the sign; gt() means greater than.
    // Check both positive and negative results against the database limit.
    if (value.abs().gt(MAX_MONEY_AMOUNT)) {
      throw new DomainError(DOMAIN_ERRORS.MONEY_OVERFLOW);
    }
    // Object.freeze prevents changes to this object's properties at runtime.
    // It is shallow: the Decimal stays private, and arithmetic creates new values.
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (!isValidAmountFormat(amount)) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_AMOUNT);
    }
    if (!isSupportedCurrency(currency)) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_CURRENCY);
    }
    // Convert the validated string directly to Decimal, without passing through
    // a JavaScript number. Only this class can call the private constructor.
    return new Money(new MONEY_DECIMAL(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    // Internal calculations may produce negative values; external inputs may not.
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt('0');
  }

  isNegative(): boolean {
    return this.value.lt('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.eq(other.value);
  }

  toString(): string {
    // Decimal.toFixed returns a string with two decimal places, including trailing zeros.
    return this.value.toFixed(MONEY_DECIMAL_PLACES);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(DOMAIN_ERRORS.CURRENCY_MISMATCH);
    }
  }
}
