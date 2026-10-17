export const ENDPOINTS = {
  WALLETS: 'wallets',
  WAGERING: 'wagering',
  PROVIDERS: 'providers',
  METRICS: 'metrics',
  HEALTH: 'health',
} as const;

export const WALLET_ROUTES = {
  WALLET_BY_ID: ':walletId', // /wallets/:walletId
  WALLET_LEDGER: ':walletId/ledger', // /wallets/:walletId/ledger
  WALLET_RECONCILIATION: ':walletId/reconciliation', // /wallets/:walletId/reconciliation
} as const;

export const WAGER_ROUTES = {
  TRANSACTIONS: 'transactions', // /wagering/transactions
  TRANSACTION_BY_ID: 'transactions/:transactionId', // /wagering/transactions/:transactionId
  PROVIDER_TRANSACTION_BY_EXTERNAL_ID: ':providerId/wagering/transactions/:externalTransactionId', // /providers/:providerId/wagering/transactions/:externalTransactionId
} as const;

export const HEALTH_ROUTES = {
  HEALTH_LIVENESS: 'live', // /health/live
  HEALTH_READINESS: 'ready', // /health/ready
} as const;
