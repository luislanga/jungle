import type { EventEnvelope } from '@/shared/interfaces/event.interface';

export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export type ReceiveInboxMessageProps = Omit<InboxState, 'receivedAt' | 'processedAt'>;
