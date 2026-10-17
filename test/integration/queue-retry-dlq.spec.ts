import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  failureOf,
  financialServices,
  openTestWallet,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { DEAD_LETTER_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

let db: Awaited<ReturnType<typeof startMessagingTest>>, consumer: SqsWagerConsumer, dlq: string;
beforeAll(async () => {
  db = await startMessagingTest();
  dlq = await db.sqs.queueUrl(DEAD_LETTER_QUEUE_NAME);
  consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, {
    ...db.config,
    SQS_RETRY_BASE_SECONDS: 0,
    SQS_RETRY_MAX_SECONDS: 0,
  });
}, 180_000);
afterAll(async () => {
  await db?.close();
}, 30_000);

async function receive(queue = db.queueUrl): Promise<Message> {
  let found: Message | undefined;
  await waitFor(async () => {
    [found] = await db.sqs.receive(queue);
    return found !== undefined;
  });
  return found!;
}

async function exhaust(body: string, initial?: Message) {
  for (let count = 1; count <= 5; count++) {
    const message = count === 1 && initial ? initial : await receive();
    expect(message.Body).toBe(body);
    expect(message.Attributes?.ApproximateReceiveCount).toBe(String(count));
    expect(await failureOf(consumer.handle(db.queueUrl, message))).toBeInstanceOf(Error);
  }
  // The next source receive lets SQS evaluate its maxReceiveCount redrive policy.
  await db.sqs.receive(db.queueUrl);
  await waitFor(async () => (await db.sqs.queueDepth(dlq)).visible === 1);
  const before = await db.sqs.queueDepth(dlq),
    after = await db.sqs.queueDepth(dlq);
  expect(after).toEqual(before); // observation does not receive or delete DLQ work
  return receive(dlq);
}

test('malformed JSON/envelopes reach the actual FIFO DLQ after five receives, with original bodies retained', async () => {
  const attributes = await db.sqs.client.send(
    new GetQueueAttributesCommand({ QueueUrl: db.queueUrl, AttributeNames: ['RedrivePolicy'] }),
  );
  expect(
    Number(
      (JSON.parse(attributes.Attributes!.RedrivePolicy!) as { maxReceiveCount: number | string })
        .maxReceiveCount,
    ),
  ).toBe(5);
  const retention = await db.sqs.client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['MessageRetentionPeriod'] }),
  );
  expect(retention.Attributes?.MessageRetentionPeriod).toBe('1209600');
  for (const body of ['not-json', JSON.stringify({ type: 'WrongEnvelope' })]) {
    await db.sqs.send(
      db.queueUrl,
      body,
      crypto.randomUUID(),
      crypto.randomUUID()
    );
    const dead = await exhaust(body);
    expect(dead.Body).toBe(body);
    await db.sqs.delete(dlq, dead.ReceiptHandle!);
  }
  const [row] = await db.app.query<Array<{ count: number }>>(
    'SELECT count(*)::int AS count FROM wagering.wager_transactions',
  );
  expect(row?.count).toBe(0);
}, 30_000);

test('database connection outage leaves the message unacked without FAILED, then recovers', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet);
  await enqueueWager(db, command);
  const message = await receive();
  try {
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      "ALTER ROLE wager_app CONNECTION LIMIT 0; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='wager_app';",
    ]);
    expect(await failureOf(consumer.handle(db.queueUrl, message))).toBeInstanceOf(Error);
  } finally {
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      'ALTER ROLE wager_app CONNECTION LIMIT -1;',
    ]);
  }
  await waitFor(async () => {
    try {
      await db.app.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  });
  await consumer.handle(db.queueUrl, await receive());
  const [row] = await db.app.query<Array<{ failed: number }>>(
    "SELECT count(*)::int AS failed FROM wagering.wager_transactions WHERE wallet_id=$1 AND status='FAILED'",
    [wallet.id],
  );
  expect(row?.failed).toBe(0);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('real SQS acknowledgement outage after commit recovers with one debit even if the acknowledgement outcome is uncertain', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet),
    messageId = crypto.randomUUID();
  await enqueueWager(db, command, messageId);
  const message = await receive();
  const short = new SqsGateway({ ...db.config, SQS_REQUEST_TIMEOUT_MS: 500 });
  await short.queueUrl('wager-transactions.fifo');
  const worker = new SqsWagerConsumer(short, financialServices(db.app).process, db.config);
  try {
    await db.run(['pause', 'localstack']);
    expect(await failureOf(worker.handle(db.queueUrl, message))).toBeInstanceOf(Error);
    await assertWalletLedger(db.app, wallet.id, '75.00');
  } finally {
    await db.run(['unpause', 'localstack']);
    short.close();
  }
  await db.sqs.changeVisibility(db.queueUrl, message.ReceiptHandle!, 0).catch(() => undefined);
  await enqueueWager(db, command, messageId);
  await waitFor(async () => {
    await consumer.pollOnce();
    const depth = await db.sqs.queueDepth(db.queueUrl);
    return depth.visible === 0 && depth.inFlight === 0;
  });
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 30_000);

test('redrive after repeated lost acknowledgements preserves the durable Inbox and original financial result', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet);
  await enqueueWager(db, command);
  const first = await receive();
  const ack = spyOn(db.sqs, 'delete').mockRejectedValue(new Error('Injected lost acknowledgement'));
  let dead: Message;
  try {
    dead = await exhaust(first.Body!, first);
  } finally {
    ack.mockRestore();
  }
  await assertWalletLedger(db.app, wallet.id, '75.00');
  // Operator redrive sends before removing the DLQ record. The original envelope/key stay unchanged.
  await db.sqs.send(
    db.queueUrl,
    dead.Body!,
    wallet.id,
    crypto.randomUUID()
  );
  await db.sqs.delete(dlq, dead.ReceiptHandle!);
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  const [row] = await db.app.query<Array<{ debits: number }>>(
    "SELECT count(*)::int AS debits FROM wagering.wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT'",
    [wallet.id],
  );
  expect(row?.debits).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 30_000);
