import { Controller, Get, Header, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/database/database.module';
import type { DatabaseConfig } from '@/config/database';
import { withTransaction } from '@/database/transaction';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';
import { DEAD_LETTER_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import {
  METRICS_REGISTRY,
  DLQ_DEPTH,
  OUTBOX_LAG,
  RECONCILIATION_COUNT,
  DEPENDENCY_UP,
  COLLECTION_ERRORS,
} from '@/shared/infrastructure/metrics/metrics';
import { safeErrorContext, writeLog } from '@/shared/infrastructure/logging/application.logger';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(DATABASE_CONFIG) private readonly databaseConfig: DatabaseConfig,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(ReconciliationSignals) private readonly reconciliation: ReconciliationSignals,
  ) {}

  @Get()
  @Header('Content-Type', METRICS_REGISTRY.contentType)
  async get() {
    const results = await Promise.allSettled([this.outboxLag(), this.dlqDepth()]);
    for (const [index, result] of results.entries()) {
      const dependency = index === 0 ? 'database' : 'sqs';
      DEPENDENCY_UP.set({ dependency }, result.status === 'fulfilled' ? 1 : 0);
      if (result.status === 'rejected') {
        COLLECTION_ERRORS.inc({ dependency });
        writeLog(
          'metrics_collection_failed',
          { ...safeErrorContext(result.reason), worker: dependency },
          'warn',
        );
      }
    }
    RECONCILIATION_COUNT.set(this.reconciliation.discrepancyCount);
    return METRICS_REGISTRY.metrics();
  }

  private async outboxLag() {
    const [row] = await withTransaction(this.dataSource, this.databaseConfig, (manager) =>
      manager.query<Array<{ seconds: string }>>(
        `SELECT coalesce(greatest(extract(epoch FROM (clock_timestamp()-min(occurred_at))),0),0)::text AS seconds FROM wagering.outbox_messages WHERE published_at IS NULL`,
      ),
    );
    OUTBOX_LAG.set(Number(row?.seconds ?? '0'));
  }

  private async dlqDepth() {
    const depth = await this.sqs.queueDepth(await this.sqs.queueUrl(DEAD_LETTER_QUEUE_NAME));
    DLQ_DEPTH.set(depth.visible + depth.inFlight);
  }
}
