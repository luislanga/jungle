// This executable fixture is excluded from production builds. Its pauses are test-only.
import { createDatabaseDataSource } from '@/database/data-source';
import { DATABASE_ENTITIES } from '@/database/entities';
import { readDatabaseConfig } from '@/config/database';
import { readMessagingConfig } from '@/config/messaging';
import { readOutboxConfig } from '@/config/outbox';
import { readWorkerConfig } from '@/config/workers';
import { readPendingReferenceConfig } from '@/config/pending-reference';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { WorkerRuntime } from '@/modules/messaging/infrastructure/worker.runtime';

const database = readDatabaseConfig(),
  messaging = readMessagingConfig(),
  outbox = readOutboxConfig(),
  pending = readPendingReferenceConfig();
const dataSource = await createDatabaseDataSource(database, DATABASE_ENTITIES).initialize();
const sqs = new SqsGateway(messaging);
const processWager = new ProcessWagerTransactionUseCase(dataSource, database, pending);
const phase = (value: string) =>
  process.stdout.write(JSON.stringify({ phase: value, pid: process.pid }) + '\n');
const acknowledge = sqs.delete.bind(sqs);
sqs.delete = async (...args) => {
  await acknowledge(...args);
  phase('acked');
};
if (process.env.TEST_WORKER_MODE === 'short-initial-visibility') {
  const receive = sqs.receive.bind(sqs);
  sqs.receive = async (...args) => {
    const messages = await receive(...args);
    for (const message of messages)
      if (message.ReceiptHandle) await sqs.changeVisibility(args[0], message.ReceiptHandle, 1);
    return messages;
  };
}
if (process.env.TEST_WORKER_MODE === 'hold-before-ack') {
  sqs.delete = async () => {
    phase('before-ack');
    await new Promise<void>(() => {});
  };
}
if (process.env.TEST_WORKER_MODE === 'hold-after-publish') {
  const original = sqs.send.bind(sqs);
  sqs.send = async (...args) => {
    const result = await original(...args);
    phase('after-publish');
    await new Promise<void>(() => {});
    return result;
  };
}
const consumer = new SqsWagerConsumer(sqs, processWager, messaging);
const runtime = new WorkerRuntime(
  consumer,
  new OutboxPublisher(
    dataSource,
    database,
    sqs,
    outbox
  ),
  new PendingReferenceResolver(
    dataSource,
    database,
    processWager,
    pending
  ),
  {
    worker: readWorkerConfig(),
    messaging,
    outbox,
    pending,
  },
);
process.once('SIGTERM', () => {
  void (async () => {
    await runtime.stop();
    sqs.close();
    await dataSource.destroy();
    process.exit(0);
  })();
});
runtime.start();
phase('started');
