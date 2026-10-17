import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

@Entity({ name: 'outbox_messages', schema: 'wagering' })
export class OutboxMessageEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: EventEnvelope;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({
    name: 'published_at',
    type: 'timestamptz',
    nullable: true,
  })
  publishedAt!: Date | null;

  @Column({
    name: 'claim_owner',
    type: 'text',
    nullable: true,
  })
  claimOwner!: string | null;

  @Column({
    name: 'claim_token',
    type: 'uuid',
    nullable: true,
  })
  claimToken!: string | null;

  @Column({
    name: 'claim_until',
    type: 'timestamptz',
    nullable: true,
  })
  claimUntil!: Date | null;
}
