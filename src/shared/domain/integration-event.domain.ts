import type { EventEnvelope, IntegrationEventProps } from '@/shared/interfaces/event.interface';
import { freezeData } from '@/shared/utils/object.util';

export abstract class IntegrationEvent<Data> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  private readonly props: IntegrationEventProps<Data>;

  protected constructor(props: IntegrationEventProps<Data>) {
    this.props = {
      ...props,
      occurredAt: new Date(props.occurredAt),
      data: structuredClone(props.data),
    };
    freezeData(this.props.data);
    Object.freeze(this.props);
  }

  get eventId(): string {
    return this.props.eventId;
  }

  get aggregateId(): string {
    return this.props.aggregateId;
  }

  get correlationId(): string {
    return this.props.correlationId;
  }

  get causationId(): string | undefined {
    return this.props.causationId;
  }

  get occurredAt(): Date {
    return new Date(this.props.occurredAt);
  }

  get data(): Readonly<Data> {
    return this.props.data;
  }

  toJSON(): EventEnvelope<Data> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      data: structuredClone(this.props.data),
    };
  }
}
