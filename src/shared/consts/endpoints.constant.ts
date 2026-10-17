export const ENDPOINTS = {
  WALLETS: 'wallets',
  WAGERING: 'wagering',
  PROVIDERS: 'providers',
} as const;

export const WALLET_ROUTES = {
  WALLET_BY_ID: ':walletId', // /wallets/:walletId
  WALLET_LEDGER: ':walletId/ledger', // /wallets/:walletId/ledger
} as const;

export const WAGER_ROUTES = {
  TRANSACTIONS: 'transactions', // /wagering/transactions
  TRANSACTION_BY_ID: 'transactions/:transactionId', // /wagering/transactions/:transactionId
  PROVIDER_TRANSACTION_BY_EXTERNAL_ID: ':providerId/wagering/transactions/:externalTransactionId', // /providers/:providerId/wagering/transactions/:externalTransactionId
} as const;
