import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/database/database.module';
import type { DatabaseConfig } from '@/config/database';
import { MESSAGE_QUEUE, type MessageQueue } from '@/shared/interfaces/message-queue.interface';
import {
  HEALTH_CHECKS,
  OUTBOX_LAG_READER,
  type OutboxLagReader,
} from '@/shared/interfaces/health.interface';
import { HealthChecksAdapter } from '@/modules/health/infrastructure/health-checks.adapter';
import { createOutboxLagReader } from '@/modules/health/infrastructure/outbox-lag.factory';
import { MetricsService } from '@/modules/health/application/metrics.service';
import { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';

export const HEALTH_PROVIDERS: Provider[] = [
  {
    provide: HEALTH_CHECKS,
    inject: [DATABASE_CONFIG, MESSAGE_QUEUE],
    useFactory: (database: DatabaseConfig, sqs: MessageQueue) =>
      new HealthChecksAdapter(database, sqs),
  },
  {
    provide: OUTBOX_LAG_READER,
    inject: [DataSource, DATABASE_CONFIG],
    useFactory: createOutboxLagReader,
  },
  {
    provide: MetricsService,
    inject: [OUTBOX_LAG_READER, MESSAGE_QUEUE, ReconciliationSignals],
    useFactory: (
      readOutboxLag: OutboxLagReader,
      sqs: MessageQueue,
      reconciliation: ReconciliationSignals,
    ) => new MetricsService(readOutboxLag, sqs, reconciliation),
  },
];
