import { readMessagingConfig, type MessagingConfig } from '@/config/messaging';
import {
  deliveryFailureKind,
  deliveryRetryDelay,
} from '@/modules/messaging/application/delivery-failure.policy';
import type { SqsWagerMessage } from '@/shared/interfaces/wager-command.interface';
import type { Message } from '@aws-sdk/client-sqs';
import type { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { parseSqsWager } from '@/modules/wagering/application/contracts/wager-command.contract';
import type { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { INBOUND_QUEUE_NAME, WAGER_CONSUMER_NAME } from '@/shared/consts/messaging.constant';

export class SqsWagerConsumer {
  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly config: MessagingConfig = readMessagingConfig(),
  ) {}

  async pollOnce(signal?: AbortSignal) {
    const queueUrl = await this.sqs.queueUrl(INBOUND_QUEUE_NAME);
    const messages = await this.sqs.receive(queueUrl, signal);
    const results = await Promise.allSettled(
      messages.map((message) => this.handle(queueUrl, message)),
    );
    return {
      received: messages.length,
      acknowledged: results.filter((result) => result.status === 'fulfilled').length,
    };
  }

  async handle(queueUrl: string, message: Message): Promise<void> {
    let envelope: SqsWagerMessage | undefined;
    try {
      if (!message.Body || !message.ReceiptHandle)
        throw new SyntaxError('SQS delivery is missing its body or receipt');
      envelope = parseSqsWager(JSON.parse(message.Body) as unknown);
      await this.processWager.execute(envelope.command, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        // The envelope ID survives republishing; SQS MessageId identifies only one delivery.
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
      });
      // SQL has committed, including rejected and durably pending outcomes.
      // A failed DeleteMessage can redeliver, so its durable Inbox remains authoritative.
      await this.sqs.delete(queueUrl, message.ReceiptHandle);
    } catch (error) {
      const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const receiveCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
      process.stderr.write(
        JSON.stringify({
          level: 'warn',
          event: 'sqs_delivery_failed',
          classification: deliveryFailureKind(error),
          receiveCount,
          sqsMessageId: message.MessageId,
          ...(envelope
            ? {
                messageId: envelope.messageId,
                correlationId: envelope.messageId,
                walletId: envelope.command.data.walletId,
                providerId: envelope.command.data.providerId,
              }
            : {}),
        }) + '\n',
      );
      if (message.ReceiptHandle) {
        try {
          await this.sqs.changeVisibility(
            queueUrl,
            message.ReceiptHandle,
            deliveryRetryDelay(receiveCount, this.config),
          );
        } catch {
          /* Broker outage: the existing visibility timeout still permits redelivery. */
        }
      }
      // SQS's configured maxReceiveCount moves persistent failures to its FIFO DLQ.
      // Never acknowledge an uncommitted result, or manufacture FAILED because of an outage.
      throw error;
    }
  }
}
