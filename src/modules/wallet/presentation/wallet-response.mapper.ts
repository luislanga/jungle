import type { Wallet } from '@/modules/wallet/domain/wallet.domain';

export function walletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
