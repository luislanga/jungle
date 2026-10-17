import type { LedgerCursor, LedgerQueryRow } from '@/shared/interfaces/wallet.interface';
import type { Wallet } from '@/modules/wallet/domain/wallet.domain';

export interface WalletQueries {
  findById(id: string): Promise<Wallet | null>;
  listLedger(walletId: string, limit: number, cursor?: LedgerCursor): Promise<LedgerQueryRow[]>;
}
