import type { OutboxState } from '@/shared/interfaces/messaging.interface';
import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { DomainError } from '@/shared/errors/domain.error';
import type { IntegrationEvent } from '@/shared/domain/integration-event.domain';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({
      ...state,
      payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt),
      ...(state.nextAttemptAt ? { nextAttemptAt: new Date(state.nextAttemptAt) } : {}),
      ...(state.publishedAt ? { publishedAt: new Date(state.publishedAt) } : {}),
    });
  }
  get id(): string {
    return this.state.id;
  }
  get aggregateId(): string {
    return this.state.aggregateId;
  }
  get eventType(): string {
    return this.state.eventType;
  }
  get payload(): EventEnvelope {
    return structuredClone(this.state.payload);
  }
  get occurredAt(): Date {
    return new Date(this.state.occurredAt);
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : undefined;
  }
  get publishedAt(): Date | undefined {
    return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined;
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return this.isPending() && (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now);
  }
  markPublished(at: Date): void {
    if (this.isPending()) this.state.publishedAt = new Date(at);
  }
  scheduleRetry(
    now: Date,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    random = Math.random,
  ): void {
    if (!this.isPending()) throw new DomainError(DOMAIN_ERRORS.INVALID_OUTBOX_STATE);
    this.state.attempts++;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (this.attempts - 1));
    this.state.nextAttemptAt = new Date(now.getTime() + Math.floor(random() * ceiling));
  }
}
