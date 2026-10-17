import type { EntityManager } from 'typeorm';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { WalletLedgerEntryEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '@/modules/wallet/infrastructure/persistence/mappers/wallet-ledger-entry.mapper';
import { requireTransaction } from '@/database/require-transaction.util';

export class WalletLedgerEntryRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    requireTransaction(this.manager);
    await this.manager
      .getRepository(WalletLedgerEntryEntity)
      .insert(WalletLedgerEntryMapper.toPersistence(entry));
  }

  async findByTransaction(transactionId: string): Promise<WalletLedgerEntry | null> {
    const row = await this.manager
      .getRepository(WalletLedgerEntryEntity)
      .findOneBy({ transactionId });
    return row ? WalletLedgerEntryMapper.toDomain(row) : null;
  }
}
