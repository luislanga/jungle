import type { Wallet } from '@/modules/wallet/domain/wallet.domain';
import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import type { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import type { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import type { Money } from '@/shared/domain/money.domain';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';
import type { WagerTransactionKind } from '@/shared/enums/wager.enum';

// These repositories work together in one financial transaction. The TypeORM
// adapter supplies them from the same manager and supplies fresh ones on retry.
export interface FinancialRepositories {
  wallets: {
    findById(id: string, lock?: boolean): Promise<Wallet | null>;
    insert(wallet: Wallet): Promise<void>;
    save(wallet: Wallet): Promise<void>;
  };
  wagers: {
    findById(id: string, lock?: boolean): Promise<StoredWager | null>;
    findByKey(key: string, lock?: boolean): Promise<StoredWager | null>;
    findByExternalId(providerId: string, externalId: string): Promise<StoredWager | null>;
    processedReversalKinds(referenceId: string): Promise<WagerTransactionKind[]>;
    insert(transaction: WagerTransaction, balance: Money): Promise<void>;
    insertIfAbsent(transaction: WagerTransaction): Promise<void>;
    save(transaction: WagerTransaction, balance: Money): Promise<void>;
  };
  ledger: { insert(entry: WalletLedgerEntry): Promise<void> };
  inbox: {
    receive(message: InboxMessage): Promise<InboxMessage>;
    save(message: InboxMessage): Promise<void>;
  };
  outbox: { enqueue(message: OutboxMessage): Promise<void> };
  pending: {
    schedule(transactionId: string, expiresAt: Date, nextAttemptAt: Date): Promise<void>;
    findClaim(
      transactionId: string,
      token: string,
    ): Promise<{ attempts: number; expiresAt: Date } | null>;
    scheduleRetry(transactionId: string, token: string, nextAttemptAt: Date): Promise<boolean>;
    complete(transactionId: string, token: string): Promise<boolean>;
  };
}

export type FinancialTransaction = <Result>(
  work: (repositories: FinancialRepositories) => Promise<Result>,
) => Promise<Result>;
