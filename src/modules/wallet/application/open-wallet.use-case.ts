import type { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import { withTransaction } from '@/database/transaction';
import { isUniqueViolation } from '@/database/postgres-error.util';
import { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import { WalletLedgerEntryRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet-ledger-entry.repository';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '@/modules/messaging/domain/events.domain';
import { Money } from '@/shared/domain/money.domain';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { ApplicationError } from '@/shared/errors/application.error';
import { DomainError } from '@/shared/errors/domain.error';
import { APPLICATION_ERRORS, DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { canonicalHash } from '@/shared/utils/hash.util';
import type { OpenWalletInput } from '@/shared/interfaces/wallet.interface';
import type { EventContext } from '@/shared/interfaces/event.interface';

export class OpenWalletUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: DatabaseConfig,
  ) {}

  async execute(input: OpenWalletInput, context: EventContext): Promise<Wallet> {
    if (input.initialBalance.currency !== 'BRL')
      throw new DomainError(DOMAIN_ERRORS.UNSUPPORTED_CURRENCY);
    try {
      // PostgreSQL commits the wallet, opening entry and events together. No SQS send happens here.
      // A CHECK cannot ensure balance equals the ledger total; all these writes must use this manager.
      return await withTransaction(this.dataSource, this.config, async (manager) => {
        const at = new Date();
        const wallet = Wallet.open({ ...input, id: crypto.randomUUID() }, at);
        await new WalletRepository(manager).insert(wallet);
        // README leaves zero opening unspecified. Our approved interpretation creates
        // an empty wallet without claiming a financial movement or publishing balance events.
        if (wallet.balance.isZero()) return wallet;
        const id = crypto.randomUUID();
        const tx = WagerTransaction.opening(
          {
            id,
            providerId: 'internal',
            externalTransactionId: id,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: canonicalHash({
              walletId: wallet.id,
              initialBalance: wallet.balance.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'internal',
            money: wallet.balance,
          },
          at,
        );
        tx.markProcessed(undefined, at);
        const entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: tx.id,
          direction: LedgerDirection.Credit,
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: at,
        });
        await new WagerTransactionRepository(manager).insert(tx, wallet.balance);
        await new WalletLedgerEntryRepository(manager).insert(entry);
        const outbox = new OutboxMessageRepository(manager);
        await outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(tx, wallet.balance, {
              ...context,
              eventId: crypto.randomUUID(),
              occurredAt: at,
            }),
          ),
        );
        await outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, {
              ...context,
              eventId: crypto.randomUUID(),
              occurredAt: at,
            }),
          ),
        );
        return wallet;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_id_currency_key'))
        throw new ApplicationError(APPLICATION_ERRORS.WALLET_CONFLICT);
      throw error;
    }
  }
}
