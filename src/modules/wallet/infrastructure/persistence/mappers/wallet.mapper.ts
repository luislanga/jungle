import { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet.entity';
import { Money } from '@/shared/domain/money.domain';

export class WalletMapper {
  static toDomain(row: WalletEntity): Wallet {
    return Wallet.rehydrate({
      ...row,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
    });
  }
  static toPersistence(wallet: Wallet): WalletEntity {
    return Object.assign(new WalletEntity(), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  }
}
