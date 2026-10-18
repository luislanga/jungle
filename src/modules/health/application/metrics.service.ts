import type { MessageQueue } from '@/shared/interfaces/message-queue.interface';
import type { OutboxLagReader } from '@/shared/interfaces/health.interface';
import { DEAD_LETTER_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import {
  METRICS_REGISTRY,
  DLQ_DEPTH,
  OUTBOX_LAG,
  DEPENDENCY_UP,
  COLLECTION_ERRORS,
} from '@/shared/infrastructure/metrics/metrics';
import { safeErrorContext, writeLog } from '@/shared/infrastructure/logging/application.logger';

export class MetricsService {
  constructor(
    private readonly readOutboxLag: OutboxLagReader,
    private readonly sqs: MessageQueue,
  ) {}

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
    return METRICS_REGISTRY.metrics();
  }

  private async outboxLag() {
    OUTBOX_LAG.set(await this.readOutboxLag());
  }

  private async dlqDepth() {
    const depth = await this.sqs.queueDepth(await this.sqs.queueUrl(DEAD_LETTER_QUEUE_NAME));
    DLQ_DEPTH.set(depth.visible + depth.inFlight);
  }
}
