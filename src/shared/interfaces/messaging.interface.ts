import type { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

export interface InboxIdentity {
  consumerName: string;
  messageId: string;
}

export interface InboxState extends InboxIdentity {
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

export interface WorkClaimOptions {
  owner: string;
  limit: number;
  leaseMs: number;
}
export interface ClaimedOutbox {
  message: OutboxMessage;
  token: string;
}
export interface PendingReferenceClaim {
  transactionId: string;
  attempts: number;
  expiresAt: Date;
  token: string;
}
