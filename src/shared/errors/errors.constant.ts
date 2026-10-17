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
  REVERSAL_INSUFFICIENT_FUNDS: {
    code: 'REVERSAL_INSUFFICIENT_FUNDS',
    message: 'Operation would make the wallet balance negative',
  },
  WAGER_INSUFFICIENT_FUNDS: {
    code: 'INSUFFICIENT_FUNDS',
    message: 'Operation would make the wallet balance negative',
  },
  INVALID_TRANSACTION_KIND: {
    code: 'INVALID_TRANSACTION_KIND',
    message: 'OPENING is internal; submit a supported external operation',
  },
  REFERENCE_REQUIRED: {
    code: 'REFERENCE_REQUIRED',
    message: 'This operation requires a reference',
  },
  INVALID_REFERENCE: {
    code: 'INVALID_REFERENCE',
    message: 'A transaction cannot reference itself',
  },
  REFERENCE_CONTEXT_MISMATCH: {
    code: 'REFERENCE_CONTEXT_MISMATCH',
    message: 'Reference belongs to a different operation context',
  },
  REFERENCE_NOT_PROCESSED: {
    code: 'REFERENCE_NOT_PROCESSED',
    message: 'Reference was not processed successfully',
  },
  INVALID_REFERENCE_KIND: {
    code: 'INVALID_REFERENCE_KIND',
    message: 'Reference has an ineligible operation kind',
  },
  REFERENCE_AMOUNT_MISMATCH: {
    code: 'REFERENCE_AMOUNT_MISMATCH',
    message: 'Reversal amount must equal the referenced amount',
  },
  REFERENCE_ALREADY_REVERSED: {
    code: 'REFERENCE_ALREADY_REVERSED',
    message: 'Reference has already been reversed by this operation kind',
  },
  REVERSAL_REFERENCE_NOT_PROCESSED: {
    code: 'REFERENCE_NOT_PROCESSED',
    message: 'A processed reference is required for the reversal direction',
  },
  INVALID_TRANSACTION_STATE: {
    code: 'INVALID_TRANSACTION_STATE',
    message: 'Terminal transactions cannot change state',
  },
  INVALID_WAGER_AMOUNT: {
    code: 'INVALID_AMOUNT',
    message: 'Only LOSS may have a zero amount; negative inputs are not accepted',
  },
} as const;

export type DomainErrorDefinition = (typeof DOMAIN_ERRORS)[keyof typeof DOMAIN_ERRORS];
