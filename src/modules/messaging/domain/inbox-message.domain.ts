import type { InboxState, ReceiveInboxMessageProps } from '@/shared/interfaces/messaging.interface';
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}

  static receive(props: ReceiveInboxMessageProps, at = new Date()): InboxMessage {
    return InboxMessage.rehydrate({ ...props, receivedAt: at });
  }

  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      ...(state.processedAt ? { processedAt: new Date(state.processedAt) } : {}),
    });
  }

  get messageId(): string {
    return this.state.messageId;
  }

  get consumerName(): string {
    return this.state.consumerName;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get receivedAt(): Date {
    return new Date(this.state.receivedAt);
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  matchesPayload(hash: string): boolean {
    return hash === this.payloadHash;
  }

  markProcessed(at: Date): void {
    if (!this.isProcessed()) this.state.processedAt = new Date(at);
  }
}
