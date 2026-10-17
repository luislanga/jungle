export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum ReferenceValidationStatus {
  Ready = 'READY',
  PendingReference = 'PENDING_REFERENCE',
}

export enum FailureCode {
  MoneyOverflow = 'MONEY_OVERFLOW',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceNotFoundExpired = 'REFERENCE_NOT_FOUND_EXPIRED',
  InvalidTransactionState = 'INVALID_TRANSACTION_STATE',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  ExternalTransactionConflict = 'EXTERNAL_TRANSACTION_CONFLICT',
  InboxPayloadConflict = 'INBOX_PAYLOAD_CONFLICT',
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}
