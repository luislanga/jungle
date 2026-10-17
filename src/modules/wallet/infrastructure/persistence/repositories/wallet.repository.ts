import type { EntityManager } from 'typeorm';
import type { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet.entity';
import { WalletMapper } from '@/modules/wallet/infrastructure/persistence/mappers/wallet.mapper';
import { requireTransaction } from '@/database/require-transaction.util';

export class WalletRepository {
  constructor(private readonly manager: EntityManager) {}
  async findById(id: string, lock = false): Promise<Wallet | null> {
    const query = this.manager
      .getRepository(WalletEntity)
      .createQueryBuilder('wallet')
      .where('wallet.id = :id', { id });
    if (lock) {
      requireTransaction(this.manager);
      query.setLock('pessimistic_write');
    }
    const row = await query.getOne();
    return row ? WalletMapper.toDomain(row) : null;
  }
  async insert(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.getRepository(WalletEntity).insert(WalletMapper.toPersistence(wallet));
  }
  async save(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.getRepository(WalletEntity).update(wallet.id, {
      balance: wallet.balance.toString(),
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    });
  }
}
