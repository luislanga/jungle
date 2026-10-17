import { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import { InboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/inbox-message.entity';

export class InboxMessageMapper {
  static toDomain(row: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: row.consumerName,
      messageId: row.messageId,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      ...(row.processedAt === null ? {} : { processedAt: row.processedAt }),
    });
  }
  static toPersistence(message: InboxMessage): InboxMessageEntity {
    return Object.assign(new InboxMessageEntity(), {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}
