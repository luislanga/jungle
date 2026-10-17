import type { EntityManager } from 'typeorm';
import type { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import { InboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/inbox-message.entity';
import { InboxMessageMapper } from '@/modules/messaging/infrastructure/persistence/mappers/inbox-message.mapper';
import { requireTransaction } from '@/database/require-transaction.util';
import { DomainError } from '@/shared/errors/domain.error';
import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';

export class InboxMessageRepository {
  constructor(private readonly manager: EntityManager) {}

  async receive(message: InboxMessage): Promise<InboxMessage> {
    requireTransaction(this.manager);
    // ON CONFLICT waits for a concurrent insert without aborting this transaction.
    await this.manager
      .getRepository(InboxMessageEntity)
      .createQueryBuilder()
      .insert()
      .values(InboxMessageMapper.toPersistence(message))
      .orIgnore()
      .execute();
    const row = await this.manager
      .getRepository(InboxMessageEntity)
      .createQueryBuilder('inbox')
      .where('inbox.consumer_name = :consumer AND inbox.message_id = :id', {
        consumer: message.consumerName,
        id: message.messageId,
      })
      .setLock('pessimistic_write')
      .getOneOrFail();
    const stored = InboxMessageMapper.toDomain(row);
    if (!stored.matchesPayload(message.payloadHash))
      throw new DomainError(DOMAIN_ERRORS.INBOX_PAYLOAD_CONFLICT);
    return stored;
  }

  async save(message: InboxMessage): Promise<void> {
    requireTransaction(this.manager);
    await this.manager
      .getRepository(InboxMessageEntity)
      .update(
        { consumerName: message.consumerName, messageId: message.messageId },
        { processedAt: message.processedAt ?? null },
      );
  }
}
