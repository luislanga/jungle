import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { WalletLedgerEntryEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { Money } from '@/shared/domain/money.domain';
import type { LedgerDirection } from '@/shared/enums/wallet.enum';

export class WalletLedgerEntryMapper {
  static toDomain(row: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      ...row,
      direction: row.direction as LedgerDirection,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency }),
      balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency }),
    });
  }
  static toPersistence(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    return Object.assign(new WalletLedgerEntryEntity(), {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    });
  }
}
