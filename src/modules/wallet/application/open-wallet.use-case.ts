import {
  INTERNAL_PROVIDER_ID,
  INTERNAL_GAME_ID,
  OPENING_ROUND_ID,
  OPENING_IDEMPOTENCY_PREFIX,
} from '@/shared/consts/wager.constant';
import { isAllowedCurrency } from '@/shared/utils/money.util';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';
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
    if (!isAllowedCurrency(input.initialBalance.currency))
      throw new DomainError(DOMAIN_ERRORS.UNSUPPORTED_CURRENCY);
    try {
      const wallet = await withTransaction(this.dataSource, this.config, async (manager) => {
        const at = new Date();
        const wallet = Wallet.open({ ...input, id: crypto.randomUUID() }, at);
        await new WalletRepository(manager).insert(wallet);
        if (wallet.balance.isZero()) return wallet;
        const id = crypto.randomUUID();
        const transaction = WagerTransaction.opening(
          {
            id,
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: id,
            idempotencyKey: `${OPENING_IDEMPOTENCY_PREFIX}:${wallet.id}`,
            payloadHash: canonicalHash({
              walletId: wallet.id,
              initialBalance: wallet.balance.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: OPENING_ROUND_ID,
            gameId: INTERNAL_GAME_ID,
            money: wallet.balance,
          },
          at,
        );
        transaction.markProcessed(undefined, at);
        const entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Credit,
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: at,
        });
        await new WagerTransactionRepository(manager).insert(transaction, wallet.balance);
        await new WalletLedgerEntryRepository(manager).insert(entry);
        const outbox = new OutboxMessageRepository(manager);
        await outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, wallet.balance, {
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
      writeLog('wallet_opened', { correlationId: context.correlationId, walletId: wallet.id });
      return wallet;
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_id_currency_key'))
        throw new ApplicationError(APPLICATION_ERRORS.WALLET_CONFLICT);
      throw error;
    }
  }
}
