import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import type { OutboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/outbox-message.entity';

export class OutboxMessageMapper {
  static toDomain(row: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
    });
  }
}
