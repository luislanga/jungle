import type { Message } from '@aws-sdk/client-sqs';
import type { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { parseSqsWager } from '@/modules/wagering/application/contracts/wager-command.contract';
import type { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { INBOUND_QUEUE_NAME, WAGER_CONSUMER_NAME } from '@/shared/consts/messaging.constant';

export class SqsWagerConsumer {
  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransactionUseCase,
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
    if (!message.Body || !message.ReceiptHandle)
      throw new Error('SQS delivery is missing its body or receipt');
    const envelope = parseSqsWager(JSON.parse(message.Body) as unknown);
    await this.processWager.execute(envelope.command, {
      correlationId: envelope.messageId,
      causationId: envelope.messageId,
      // The envelope ID survives republishing; SQS MessageId identifies only one delivery.
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
    });
    // execute() resolves after SQL commit, including rejected and durably pending outcomes.
    // If DeleteMessage fails, redelivery finds the same Inbox and original business result.
    await this.sqs.delete(queueUrl, message.ReceiptHandle);
  }
}
