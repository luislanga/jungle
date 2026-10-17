import { safeErrorContext, writeLog } from '@/shared/infrastructure/logging/application.logger';
import { setTimeout as sleep } from 'node:timers/promises';
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
  private readonly active = new Map<string, { queueUrl: string; heartbeat: AbortController }>();

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly config: MessagingConfig = readMessagingConfig(),
  ) {}

  async pollOnce(signal?: AbortSignal) {
    const queueUrl = await this.sqs.queueUrl(INBOUND_QUEUE_NAME);
    const messages = await this.sqs.receive(queueUrl, signal);
    if (signal?.aborted) {
      await Promise.allSettled(
        messages
          .filter((message) => message.ReceiptHandle)
          .map((message) => this.sqs.changeVisibility(queueUrl, message.ReceiptHandle!, 0)),
      );
      return { received: messages.length, acknowledged: 0 };
    }
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
      const receipt = message.ReceiptHandle;
      const heartbeat = new AbortController();
      this.active.set(receipt, { queueUrl, heartbeat });
      const extension = this.keepVisible(queueUrl, receipt, heartbeat.signal).catch(
        (error: unknown) => {
          if (!heartbeat.signal.aborted)
            writeLog('sqs_heartbeat_failed', safeErrorContext(error), 'warn');
        },
      );
      try {
        envelope = parseSqsWager(JSON.parse(message.Body) as unknown);
        const result = await this.processWager.execute(envelope.command, {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          // The envelope ID survives republishing; SQS MessageId identifies only one delivery.
          inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
        });
        // Finish any visibility request before deleting the receipt. Otherwise a
        // late extension could race with acknowledgement at the broker.
        heartbeat.abort();
        await extension;
        // SQL has committed, including rejected and durably pending outcomes.
        // A failed DeleteMessage can redeliver, so its durable Inbox remains authoritative.
        await this.sqs.delete(queueUrl, message.ReceiptHandle);
        writeLog('sqs_acknowledged', {
          messageId: envelope.messageId,
          sqsMessageId: message.MessageId,
          correlationId: envelope.messageId,
          transactionId: result.transactionId,
          walletId: envelope.command.data.walletId,
          providerId: envelope.command.data.providerId,
          status: result.status,
        });
      } finally {
        heartbeat.abort();
        await extension;
        this.active.delete(receipt);
      }
    } catch (error) {
      const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const receiveCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
      writeLog(
        'sqs_delivery_failed',
        {
          ...safeErrorContext(error),
          status: deliveryFailureKind(error),
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
        },
        'warn',
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

  async releaseInFlight(): Promise<void> {
    await Promise.allSettled(
      [...this.active].map(([receipt, delivery]) => {
        delivery.heartbeat.abort();
        return this.sqs.changeVisibility(delivery.queueUrl, receipt, 0);
      }),
    );
  }

  private async keepVisible(queueUrl: string, receipt: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.SQS_MAX_PROCESSING_MS;
    while (!signal.aborted) {
      await sleep(this.config.SQS_HEARTBEAT_INTERVAL_MS, undefined, { signal });
      if (signal.aborted || Date.now() >= deadline) return;
      // Only an actually running handler extends visibility, within a finite budget.
      // A failed extension is safe: durable Inbox/business keys handle any redelivery.
      try {
        await this.sqs.changeVisibility(
          queueUrl,
          receipt,
          this.config.SQS_VISIBILITY_TIMEOUT_SECONDS,
        );
      } catch {
        if (signal.aborted) return;
      }
    }
  }
}
