import {
  INTERNAL_PROVIDER_ID,
  INTERNAL_GAME_ID,
  OPENING_ROUND_ID,
  OPENING_IDEMPOTENCY_PREFIX,
} from '@/shared/consts/wager.constant';
import { isAllowedCurrency } from '@/shared/utils/money.util';
import type { FinancialTransaction } from '@/shared/interfaces/financial-transaction.interface';
import { PROCESSING_DURATION, OUTCOME_COUNT } from '@/shared/infrastructure/metrics/metrics';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';
import { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '@/modules/messaging/domain/events.domain';
import { Money } from '@/shared/domain/money.domain';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { DomainError } from '@/shared/errors/domain.error';
import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { canonicalHash } from '@/shared/utils/hash.util';
import type { OpenWalletInput } from '@/shared/interfaces/wallet.interface';
import type { EventContext } from '@/shared/interfaces/event.interface';

export class OpenWalletUseCase {
  constructor(private readonly transaction: FinancialTransaction) {}

  async execute(input: OpenWalletInput, context: EventContext): Promise<Wallet> {
    if (!isAllowedCurrency(input.initialBalance.currency))
      throw new DomainError(DOMAIN_ERRORS.UNSUPPORTED_CURRENCY);
    const observe = PROCESSING_DURATION.startTimer({ operation: 'open_wallet' });
    try {
      // PostgreSQL commits the wallet, opening entry and events together. No SQS send happens here.
      // A CHECK cannot ensure balance equals the ledger total; all repositories must share the same transaction.
      const wallet = await this.transaction(async (repositories) => {
        const at = new Date();
        const wallet = Wallet.open({ ...input, id: crypto.randomUUID() }, at);
        await repositories.wallets.insert(wallet);
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
        await repositories.wagers.insert(transaction, wallet.balance);
        await repositories.ledger.insert(entry);
        const outbox = repositories.outbox;
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
      if (wallet.balance.isPositive()) OUTCOME_COUNT.inc({ status: 'PROCESSED' });
      writeLog('wallet_opened', { correlationId: context.correlationId, walletId: wallet.id });
      return wallet;
    } finally {
      observe();
    }
  }
}
