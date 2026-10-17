import { WalletEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '@/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { InboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/outbox-message.entity';
import { PendingReferenceWorkEntity } from '@/modules/messaging/infrastructure/persistence/entities/pending-reference-work.entity';

export const DATABASE_ENTITIES = [
  WalletEntity,
  WalletLedgerEntryEntity,
  WagerTransactionEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
  PendingReferenceWorkEntity,
];
