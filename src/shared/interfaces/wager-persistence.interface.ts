import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import type { Money } from '@/shared/domain/money.domain';

// Keep the original observed balance with the wager, so replay does not return today's balance.
export interface StoredWager {
  transaction: WagerTransaction;
  resultBalance: Money | null;
}
