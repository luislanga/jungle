import {
  Inject,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
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
import { WageringModule } from '@/modules/wagering/wagering.module';
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

@Module({
  imports: [WageringModule],
  providers: [
    { provide: MESSAGING_CONFIG, useFactory: () => readMessagingConfig() },
    { provide: OUTBOX_CONFIG, useFactory: () => readOutboxConfig() },
    { provide: PENDING_REFERENCE_CONFIG, useFactory: () => readPendingReferenceConfig() },
    { provide: WORKER_CONFIG, useFactory: () => readWorkerConfig() },
    {
      provide: SqsGateway,
      inject: [MESSAGING_CONFIG],
      useFactory: (config: MessagingConfig) => new SqsGateway(config),
    },
    {
      provide: SqsWagerConsumer,
      inject: [SqsGateway, ProcessWagerTransactionUseCase, MESSAGING_CONFIG],
      useFactory: (
        sqs: SqsGateway,
        processWager: ProcessWagerTransactionUseCase,
        config: MessagingConfig,
      ) => new SqsWagerConsumer(sqs, processWager, config),
    },
    {
      provide: OutboxPublisher,
      inject: [DataSource, DATABASE_CONFIG, SqsGateway, OUTBOX_CONFIG],
      useFactory: (
        dataSource: DataSource,
        database: DatabaseConfig,
        sqs: SqsGateway,
        config: OutboxConfig,
      ) => new OutboxPublisher(
        dataSource,
        database,
        sqs,
        config
      ),
    },
    {
      provide: PendingReferenceResolver,
      inject: [
        DataSource,
        DATABASE_CONFIG,
        ProcessWagerTransactionUseCase,
        PENDING_REFERENCE_CONFIG,
      ],
      useFactory: (
        dataSource: DataSource,
        database: DatabaseConfig,
        processWager: ProcessWagerTransactionUseCase,
        config: PendingReferenceConfig,
      ) => new PendingReferenceResolver(
        dataSource,
        database,
        processWager,
        config
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
  ],
  exports: [SqsGateway, MESSAGING_CONFIG],
})
export class MessagingModule
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(
    @Inject(WorkerRuntime) private readonly runtime: WorkerRuntime,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}

  onApplicationBootstrap(): void {
    this.runtime.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }

  onApplicationShutdown(): void {
    this.sqs.close();
  }
}
