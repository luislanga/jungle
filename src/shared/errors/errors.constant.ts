export const DOMAIN_ERRORS = {
  REFERENCE_NOT_FOUND_EXPIRED: {
    code: 'REFERENCE_NOT_FOUND_EXPIRED',
    message: 'Reference was not resolved within the configured retry window',
  },
  UNSUPPORTED_CURRENCY: {
    code: 'UNSUPPORTED_CURRENCY',
    message: 'This deployment accepts BRL only',
  },
  INBOX_PAYLOAD_CONFLICT: {
    code: 'INBOX_PAYLOAD_CONFLICT',
    message: 'Envelope message ID was reused with different business data',
  },
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
  EVENT_TRANSACTION_STATE_MISMATCH: {
    code: 'INVALID_TRANSACTION_STATE',
    message: 'Event must match the persisted transaction outcome',
  },
  MISSING_FAILURE_CODE: {
    code: 'MISSING_FAILURE_CODE',
    message: 'Rejected event needs a failure code',
  },
  PENDING_EVENT_REFERENCE_REQUIRED: {
    code: 'REFERENCE_REQUIRED',
    message: 'Pending reference event needs a reference',
  },
  INVALID_BALANCE_EVENT: {
    code: 'INVALID_BALANCE_EVENT',
    message: 'Balance event must describe the wallet movement',
  },
  INVALID_OUTBOX_STATE: {
    code: 'INVALID_OUTBOX_STATE',
    message: 'Published events cannot be retried',
  },
} as const;

export type DomainErrorDefinition = (typeof DOMAIN_ERRORS)[keyof typeof DOMAIN_ERRORS];

export const APPLICATION_ERRORS = {
  WALLET_NOT_FOUND: { code: 'WALLET_NOT_FOUND', message: 'Wallet was not found' },
  INVALID_WALLET_CONTEXT: {
    code: 'INVALID_WALLET_CONTEXT',
    message: 'Player or currency does not match the wallet',
  },
  IDEMPOTENCY_CONFLICT: {
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Idempotency key was reused with different business data',
  },
  EXTERNAL_TRANSACTION_CONFLICT: {
    code: 'EXTERNAL_TRANSACTION_CONFLICT',
    message: 'Provider transaction already exists with a different idempotency key',
  },
  STALE_CLAIM: { code: 'STALE_CLAIM', message: 'The work claim expired or was replaced' },
  WALLET_CONFLICT: {
    code: 'WALLET_CONFLICT',
    message: 'A wallet already exists for this player and currency',
  },
} as const;

export type ApplicationErrorDefinition =
  (typeof APPLICATION_ERRORS)[keyof typeof APPLICATION_ERRORS];
