import type { MessageQueue } from '@/shared/interfaces/message-queue.interface';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { MessagingConfig } from '@/config/messaging';

export class SqsGateway implements MessageQueue {
  readonly client: SQSClient;
  private readonly queueUrls = new Map<string, Promise<string>>();

  constructor(private readonly config: MessagingConfig) {
    this.client = new SQSClient({
      region: config.AWS_REGION,
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
      ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.AWS_ACCESS_KEY_ID,
              secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      // LocalStack may return an internal queue URL. Keep using the configured endpoint,
      // including its host-side mapped port, rather than switching to that hostname.
      useQueueUrlAsEndpoint: false,
      maxAttempts: 1,
    });
  }

  queueUrl(name: string): Promise<string> {
    const cached = this.queueUrls.get(name);
    if (cached) return cached;
    const request = this.client
      .send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS),
      })
      .then((result) => {
        if (!result.QueueUrl) throw new Error('SQS returned no queue URL');
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrls.delete(name);
        throw error;
      });
    this.queueUrls.set(name, request);
    return request;
  }

  async receive(queueUrl: string, signal?: AbortSignal) {
    const budget = AbortSignal.timeout(
      this.config.SQS_WAIT_TIME_SECONDS * 1000 + this.config.SQS_REQUEST_TIMEOUT_MS,
    );
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: this.config.SQS_WAIT_TIME_SECONDS,
        MaxNumberOfMessages: this.config.SQS_MAX_IN_FLIGHT,
        VisibilityTimeout: this.config.SQS_VISIBILITY_TIMEOUT_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: signal ? AbortSignal.any([budget, signal]) : budget },
    );
    return result.Messages ?? [];
  }

  async send(
    queueUrl: string,
    body: string,
    groupId: string,
    deduplicationId: string
  ) {
    return this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
      { abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) },
    );
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      { abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) },
    );
  }

  async changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
      {
        abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS),
      },
    );
  }

  async queueDepth(queueUrl: string) {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      { abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) },
    );
    // Observing the DLQ must not receive/delete messages or advance their receive counts.
    return {
      visible: Number(result.Attributes?.ApproximateNumberOfMessages ?? '0'),
      inFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'),
    };
  }

  close(): void {
    this.client.destroy();
  }
}
