// These are the delivery fields our consumer uses. The AWS SDK stays in the adapter.
export interface QueueMessage {
  MessageId?: string | undefined;
  Body?: string | undefined;
  ReceiptHandle?: string | undefined;
  Attributes?: { ApproximateReceiveCount?: string | undefined } | undefined;
}

export const MESSAGE_QUEUE = Symbol('MESSAGE_QUEUE');

export interface MessageQueue {
  queueUrl(name: string): Promise<string>;
  receive(queueUrl: string, signal?: AbortSignal): Promise<QueueMessage[]>;
  send(
    queueUrl: string,
    body: string,
    groupId: string,
    deduplicationId: string
  ): Promise<unknown>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
  changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void>;
  queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }>;
}
