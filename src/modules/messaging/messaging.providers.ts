import type { Provider } from '@nestjs/common';
import { MESSAGE_QUEUE, type MessageQueue } from '@/shared/interfaces/message-queue.interface';
import {
  createOutboxStore,
  createPendingWorkStore,
} from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/database/database.module';
import type { DatabaseConfig } from '@/config/database';
import { readMessagingConfig, type MessagingConfig } from '@/config/messaging';
import { readOutboxConfig, type OutboxConfig } from '@/config/outbox';
import {
  readPendingReferenceConfig,
  type PendingReferenceConfig,
} from '@/config/pending-reference';
import { readWorkerConfig, type WorkerConfig } from '@/config/workers';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';
import { WorkerRuntime } from '@/modules/messaging/infrastructure/worker.runtime';

export const MESSAGING_CONFIG = Symbol('MESSAGING_CONFIG');
export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');
export const PENDING_REFERENCE_CONFIG = Symbol('PENDING_REFERENCE_CONFIG');
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export const MESSAGING_PROVIDERS: Provider[] = [
  { provide: MESSAGING_CONFIG, useFactory: () => readMessagingConfig() },
  { provide: OUTBOX_CONFIG, useFactory: () => readOutboxConfig() },
  { provide: PENDING_REFERENCE_CONFIG, useFactory: () => readPendingReferenceConfig() },
  { provide: WORKER_CONFIG, useFactory: () => readWorkerConfig() },
  {
    provide: SqsGateway,
    inject: [MESSAGING_CONFIG],
    useFactory: (config: MessagingConfig) => new SqsGateway(config),
  },
  { provide: MESSAGE_QUEUE, useExisting: SqsGateway },
  {
    provide: SqsWagerConsumer,
    inject: [MESSAGE_QUEUE, ProcessWagerTransactionUseCase, MESSAGING_CONFIG],
    useFactory: (
      sqs: MessageQueue,
      processWager: ProcessWagerTransactionUseCase,
      config: MessagingConfig,
    ) => new SqsWagerConsumer(sqs, processWager, config),
  },
  {
    provide: OutboxPublisher,
    inject: [DataSource, DATABASE_CONFIG, MESSAGE_QUEUE, OUTBOX_CONFIG],
    useFactory: (
      dataSource: DataSource,
      database: DatabaseConfig,
      sqs: MessageQueue,
      config: OutboxConfig,
    ) => new OutboxPublisher(createOutboxStore(dataSource, database), sqs, config),
  },
  {
    provide: PendingReferenceResolver,
    inject: [DataSource, DATABASE_CONFIG, ProcessWagerTransactionUseCase, PENDING_REFERENCE_CONFIG],
    useFactory: (
      dataSource: DataSource,
      database: DatabaseConfig,
      processWager: ProcessWagerTransactionUseCase,
      config: PendingReferenceConfig,
    ) =>
      new PendingReferenceResolver(
        createPendingWorkStore(dataSource, database),
        processWager,
        config,
      ),
  },
  {
    provide: WorkerRuntime,
    inject: [
      SqsWagerConsumer,
      OutboxPublisher,
      PendingReferenceResolver,
      WORKER_CONFIG,
      OUTBOX_CONFIG,
      PENDING_REFERENCE_CONFIG,
      MESSAGING_CONFIG,
    ],
    useFactory: (
      consumer: SqsWagerConsumer,
      publisher: OutboxPublisher,
      resolver: PendingReferenceResolver,
      worker: WorkerConfig,
      outbox: OutboxConfig,
      pending: PendingReferenceConfig,
      messaging: MessagingConfig,
    ) =>
      new WorkerRuntime(
        consumer,
        publisher,
        resolver,
        {
          worker,
          outbox,
          pending,
          messaging,
        }
      ),
  },
];
