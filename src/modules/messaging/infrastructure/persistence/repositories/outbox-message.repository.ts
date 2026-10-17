import { In, type EntityManager } from 'typeorm';
import type { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import { OutboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/outbox-message.entity';
import { OutboxMessageMapper } from '@/modules/messaging/infrastructure/persistence/mappers/outbox-message.mapper';
import { requireTransaction } from '@/database/require-transaction.util';
import type { ClaimedOutbox, WorkClaimOptions } from '@/shared/interfaces/messaging.interface';

export class OutboxMessageRepository {
  constructor(private readonly manager: EntityManager) {}
  async enqueue(message: OutboxMessage): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.query(
      `INSERT INTO wagering.outbox_messages
      (id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at,published_at)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? new Date(),
        message.publishedAt ?? null,
      ],
    );
  }
  async claimDue(options: WorkClaimOptions): Promise<ClaimedOutbox[]> {
    requireTransaction(this.manager);
    const token = crypto.randomUUID();
    // The caller commits this short claim transaction before sending anything to SQS.
    // SKIP LOCKED lets another publisher take different rows instead of waiting for this batch.
    const ids = await this.manager.query<Array<{ id: string }>>(
      `WITH due AS (
      SELECT id FROM wagering.outbox_messages
      WHERE published_at IS NULL AND next_attempt_at<=clock_timestamp()
        AND (claim_until IS NULL OR claim_until<=clock_timestamp())
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ), claimed AS (
      UPDATE wagering.outbox_messages o SET claim_owner=$2,claim_token=$3,
        claim_until=clock_timestamp()+$4 * interval '1 millisecond'
      FROM due WHERE o.id=due.id RETURNING o.id
    ) SELECT id FROM claimed`,
      [options.limit, options.owner, token, options.leaseMs],
    );
    if (!ids.length) return [];
    const rows = await this.manager
      .getRepository(OutboxMessageEntity)
      .findBy({ id: In(ids.map((row) => row.id)) });
    return rows.map((row) => ({ message: OutboxMessageMapper.toDomain(row), token }));
  }
  async markPublished(id: string, token: string): Promise<boolean> {
    requireTransaction(this.manager);
    const rows = await this.manager.query<Array<{ id: string }>>(
      `WITH completed AS (
      UPDATE wagering.outbox_messages SET published_at=clock_timestamp(),claim_owner=NULL,claim_token=NULL,claim_until=NULL
      WHERE id=$1 AND claim_token=$2 AND claim_until>clock_timestamp() AND published_at IS NULL RETURNING id
    ) SELECT id FROM completed`,
      [id, token],
    );
    return rows.length === 1;
  }
  async scheduleRetry(id: string, token: string, nextAttemptAt: Date): Promise<boolean> {
    requireTransaction(this.manager);
    const rows = await this.manager.query<Array<{ id: string }>>(
      `WITH retried AS (
      UPDATE wagering.outbox_messages SET attempts=attempts+1,next_attempt_at=$3,
        claim_owner=NULL,claim_token=NULL,claim_until=NULL
      WHERE id=$1 AND claim_token=$2 AND claim_until>clock_timestamp() AND published_at IS NULL RETURNING id
    ) SELECT id FROM retried`,
      [id, token, nextAttemptAt],
    );
    return rows.length === 1;
  }
}
