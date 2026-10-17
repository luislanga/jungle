import type { LedgerPage } from '@/shared/interfaces/wallet.interface';

export function ledgerResponse(page: LedgerPage) {
  return {
    items: page.entries.map((row) => ({
      id: row.id,
      walletId: page.walletId,
      transactionId: row.transaction_id,
      direction: row.direction,
      money: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency },
      createdAt: row.created_at,
    })),
    nextCursor: page.nextCursor,
  };
}
