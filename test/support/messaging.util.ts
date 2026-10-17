import { startPostgresTest } from '@test/support/postgres.util';
import { readMessagingConfig } from '@/config/messaging';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import type { WagerCommand } from '@/shared/interfaces/wager-command.interface';
import { INBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';

export async function startMessagingTest() {
  const db = await startPostgresTest();
  try {
    await db.run(['run', '--rm', 'queue-init']);
    const address = (await db.run(['port', 'localstack', '4566'])).trim();
    const config = readMessagingConfig({
      AWS_ENDPOINT_URL: 'http://' + address,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_WAIT_TIME_SECONDS: '0',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
    });
    const sqs = new SqsGateway(config);
    const queueUrl = await sqs.queueUrl(INBOUND_QUEUE_NAME);
    return {
      ...db,
      sqs,
      config,
      queueUrl,
      close: async () => {
        sqs.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

export function wagerEnvelope(command: WagerCommand, messageId = crypto.randomUUID()) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...command.data, idempotencyKey: command.idempotencyKey },
  };
}

export async function enqueueWager(
  db: Awaited<ReturnType<typeof startMessagingTest>>,
  command: WagerCommand,
  messageId = crypto.randomUUID(),
) {
  return db.sqs.send(
    db.queueUrl,
    JSON.stringify(wagerEnvelope(command, messageId)),
    command.data.walletId,
    crypto.randomUUID(),
  );
}
