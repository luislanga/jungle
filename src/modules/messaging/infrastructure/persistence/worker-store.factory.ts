import type { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import { withTransaction } from '@/database/transaction';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import type { OutboxStore, PendingWorkStore } from '@/shared/interfaces/worker-store.interface';

// Each method commits its short SQL transaction before returning to the worker.
// Sending to SQS and resuming financial work happen after these locks are released.
export function createOutboxStore(dataSource: DataSource, config: DatabaseConfig): OutboxStore {
  return {
    claimDue: (options) =>
      withTransaction(dataSource, config, (manager) =>
        new OutboxMessageRepository(manager).claimDue(options),
      ),
    markPublished: (id, token) =>
      withTransaction(dataSource, config, (manager) =>
        new OutboxMessageRepository(manager).markPublished(id, token),
      ),
    scheduleRetry: (id, token, nextAttemptAt) =>
      withTransaction(dataSource, config, (manager) =>
        new OutboxMessageRepository(manager).scheduleRetry(id, token, nextAttemptAt),
      ),
  };
}

export function createPendingWorkStore(
  dataSource: DataSource,
  config: DatabaseConfig,
): PendingWorkStore {
  return {
    claimDue: (options) =>
      withTransaction(dataSource, config, (manager) =>
        new PendingReferenceWorkRepository(manager).claimDue(options),
      ),
  };
}
