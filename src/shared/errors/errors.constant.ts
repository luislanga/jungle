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
  INVALID_LEDGER_ENTRY: {
    code: 'INVALID_LEDGER_ENTRY',
    message: 'Ledger movement must be positive and match the before/after balances',
  },
  INVALID_INITIAL_BALANCE: {
    code: 'INVALID_AMOUNT',
    message: 'Initial balance cannot be negative',
  },
  INSUFFICIENT_FUNDS: { code: 'INSUFFICIENT_FUNDS', message: 'Wallet has insufficient funds' },
  INVALID_WALLET_MOVEMENT: {
    code: 'INVALID_AMOUNT',
    message: 'Wallet movements cannot be negative',
  },
} as const;

export type DomainErrorDefinition = (typeof DOMAIN_ERRORS)[keyof typeof DOMAIN_ERRORS];
