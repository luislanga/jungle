export const DOMAIN_ERRORS = {
  MONEY_OVERFLOW: {
    code: 'MONEY_OVERFLOW',
    message: 'Amount exceeds NUMERIC(20,2)',
  },
  INVALID_AMOUNT: {
    code: 'INVALID_AMOUNT',
    message: 'Amount must be a nonnegative decimal string with at most two decimal places',
  },
  INVALID_CURRENCY: {
    code: 'INVALID_CURRENCY',
    message: 'Currency must be a supported uppercase ISO-4217 code',
  },
  CURRENCY_MISMATCH: {
    code: 'CURRENCY_MISMATCH',
    message: 'Money currencies must match',
  },
} as const;

export type DomainErrorDefinition = (typeof DOMAIN_ERRORS)[keyof typeof DOMAIN_ERRORS];
