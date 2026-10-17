import type { Money } from '@/shared/domain/money.domain';
import type { LedgerDirection } from '@/shared/enums/wallet.enum';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletOpeningProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
}

export interface LedgerCursor {
  version: 1;
  walletId: string;
  createdAt: string;
  id: string;
}

export interface LedgerQueryRow {
  id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string;
}

export interface LedgerPage {
  walletId: string;
  entries: LedgerQueryRow[];
  nextCursor: string | null;
}
