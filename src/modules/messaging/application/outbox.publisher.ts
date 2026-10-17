import { RETRY_COUNT } from '@/shared/infrastructure/metrics/metrics';
import { eventLogContext, writeLog } from '@/shared/infrastructure/logging/application.logger';
import { readOutboxConfig, type OutboxConfig } from '@/config/outbox';
import type { MessageQueue } from '@/shared/interfaces/message-queue.interface';
import type { OutboxStore } from '@/shared/interfaces/worker-store.interface';
import type { ClaimedOutbox } from '@/shared/interfaces/messaging.interface';
import { OUTBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';

export class OutboxPublisher {
  private readonly owner = crypto.randomUUID();

  constructor(
    private readonly store: OutboxStore,
    private readonly sqs: MessageQueue,
    private readonly config: OutboxConfig = readOutboxConfig(),
  ) {}

  async runOnce() {
    const queueUrl = await this.sqs.queueUrl(OUTBOUND_QUEUE_NAME);
    const claims = await this.store.claimDue({
      owner: this.owner,
      limit: this.config.OUTBOX_BATCH_SIZE,
      leaseMs: this.config.OUTBOX_LEASE_MS,
    });
    // The claim transaction has committed. No SQL lock remains held during network sends.
    const results = await Promise.allSettled(claims.map((claim) => this.publish(queueUrl, claim)));
    return {
      claimed: claims.length,
      published: results.filter((result) => result.status === 'fulfilled' && result.value).length,
    };
  }

  private async publish(queueUrl: string, claim: ClaimedOutbox): Promise<boolean> {
    const { message, token } = claim;
    try {
      await this.sqs.send(
        queueUrl,
        JSON.stringify(message.payload),
        message.aggregateId,
        message.id,
      );
      // If a lease expired during the send, this token cannot mark a newer owner's
      // claim as complete. The stable eventId makes a later duplicate safe to deduplicate.
      const published = await this.store.markPublished(message.id, token);
      if (published) writeLog('outbox_published', eventLogContext(message.payload));
      return published;
    } catch {
      RETRY_COUNT.inc({ source: 'outbox' });
      message.scheduleRetry(
        new Date(),
        this.config.OUTBOX_RETRY_BASE_MS,
        this.config.OUTBOX_RETRY_MAX_MS,
      );
      await this.store.scheduleRetry(message.id, token, message.nextAttemptAt!);
      // Confirmed events must never be dropped after a retry cap. Escalate after the
      // configured threshold and keep recoverable work retrying at the capped delay.
      writeLog(
        'outbox_publish_retry',
        { ...eventLogContext(message.payload), attempts: message.attempts },
        message.attempts >= this.config.OUTBOX_ESCALATE_AFTER_ATTEMPTS ? 'error' : 'warn',
      );
      return false;
    }
  }
}
