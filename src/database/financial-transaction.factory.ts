import type { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import type { FinancialTransaction } from '@/shared/interfaces/financial-transaction.interface';
import { withTransaction } from '@/database/transaction';
import { isUniqueViolation } from '@/database/postgres-error.util';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import { WalletLedgerEntryRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet-ledger-entry.repository';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { InboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/inbox-message.repository';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';

export function createFinancialTransaction(
  dataSource: DataSource,
  config: DatabaseConfig,
): FinancialTransaction {
  return async (work) => {
    try {
      return await withTransaction(dataSource, config, (manager) =>
        work({
          wallets: new WalletRepository(manager),
          wagers: new WagerTransactionRepository(manager),
          ledger: new WalletLedgerEntryRepository(manager),
          inbox: new InboxMessageRepository(manager),
          outbox: new OutboxMessageRepository(manager),
          pending: new PendingReferenceWorkRepository(manager),
        }),
      );
    } catch (error) {
      // Translate the PostgreSQL duplicate wallet error after rollback.
      // The use case does not need to know the database constraint name.
      if (isUniqueViolation(error, 'wallets_player_id_currency_key')) {
        throw new ApplicationError(APPLICATION_ERRORS.WALLET_CONFLICT);
      }
      throw error;
    }
  };
}
