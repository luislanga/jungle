import type { Wallet } from '@/modules/wallet/domain/wallet.domain';

export interface WalletQueries {
  findById(id: string): Promise<Wallet | null>;
}
