import { readMessagingConfig } from '@/config/messaging';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  wagerCommand,
} from '@test/support/financial.util';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { WAGER_CONSUMER_NAME } from '@/shared/consts/messaging.constant';
import { WagerTransactionKind } from '@/shared/enums/wager.enum';
import { canonicalHash } from '@/shared/utils/hash.util';

let http: Awaited<ReturnType<typeof startHttpTest>>;
let db: Awaited<ReturnType<typeof startMessagingTest>>, consumer: SqsWagerConsumer;
beforeAll(async () => {
  db = await startMessagingTest();
  http = await startHttpTest(db.app);
  consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, readMessagingConfig());
}, 180_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

async function counts(walletId: string) {
  return db.app.query<Array<{ debits: number; inbox: number }>>(
    `SELECT (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT') AS debits,
  (SELECT count(*)::int FROM wagering.inbox_messages WHERE consumer_name=$2) AS inbox`,
    [walletId, WAGER_CONSUMER_NAME],
  );
}

test('transport redelivery and republishing preserve envelope Inbox identity and one financial effect', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet),
    messageId = crypto.randomUUID();
  await enqueueWager(db, command, messageId);
  const [message] = await db.sqs.receive(db.queueUrl);
  expect(message).toBeDefined();
  await db.sqs.changeVisibility(db.queueUrl, message!.ReceiptHandle!, 0);
  const [redelivered] = await db.sqs.receive(db.queueUrl);
  await consumer.handle(db.queueUrl, redelivered!);
  const transport = await enqueueWager(db, command, messageId);
  expect(transport.MessageId).not.toBe(message!.MessageId);
  expect(await consumer.pollOnce()).toEqual({ received: 1, acknowledged: 1 });
  expect((await counts(wallet.id))[0]?.debits).toBe(1);
  const [row] = await db.app.query<Array<{ count: number }>>(
    'SELECT count(*)::int AS count FROM wagering.inbox_messages WHERE message_id=$1',
    [messageId],
  );
  expect(row?.count).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('different envelopes and simultaneous HTTP/SQS equivalents still debit once', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet);
  await enqueueWager(db, command);
  await Promise.all([
    consumer.pollOnce(),
    http.request('/wagering/transactions', {
      ...jsonRequest(command.data),
      headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
    }),
  ]);
  await enqueueWager(db, command);
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  expect((await counts(wallet.id))[0]?.debits).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('SQS acknowledges an HTTP replay with different UUID casing without another debit', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const response = await http.request('/wagering/transactions', {
    ...jsonRequest(command.data),
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
  });
  expect(response.status).toBe(200);
  const messageId = crypto.randomUUID();
  await enqueueWager(
    db,
    {
      ...command,
      data: {
        ...command.data,
        playerId: wallet.playerId.toUpperCase(),
        walletId: wallet.id.toUpperCase(),
      },
    },
    messageId,
  );
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  expect((await counts(wallet.id))[0]?.debits).toBe(1);
  const [inbox] = await db.app.query<Array<{ processed: boolean }>>(
    'SELECT processed_at IS NOT NULL AS processed FROM wagering.inbox_messages WHERE message_id=$1',
    [messageId],
  );
  expect(inbox?.processed).toBe(true);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('legacy UUID hashes replay across HTTP and the original Inbox without rewriting history', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const legacyData = { ...command.data, walletId: wallet.id.toUpperCase() };
  const legacyHash = canonicalHash(legacyData);
  const messageId = crypto.randomUUID();
  const original = await financialServices(db.app).process.execute(
    { ...command, data: legacyData, payloadHash: legacyHash },
    {
      correlationId: 'legacy-uuid',
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId },
    },
  );
  const replay = await http.request('/wagering/transactions', {
    ...jsonRequest(command.data),
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  await enqueueWager(db, command, messageId);
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  const conflict = await http.request('/wagering/transactions', {
    ...jsonRequest({ ...command.data, gameId: 'different-game' }),
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
  });
  expect(conflict.status).toBe(409);
  const [stored] = await db.app.query<Array<{ payload_hash: string }>>(
    'SELECT payload_hash FROM wagering.wager_transactions WHERE id=$1',
    [original.transactionId],
  );
  const [inbox] = await db.app.query<Array<{ payload_hash: string }>>(
    'SELECT payload_hash FROM wagering.inbox_messages WHERE consumer_name=$1 AND message_id=$2',
    [WAGER_CONSUMER_NAME, messageId],
  );
  expect(stored?.payload_hash).toBe(legacyHash);
  expect(inbox?.payload_hash).toBe(legacyHash);
  expect((await counts(wallet.id))[0]?.debits).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('Inbox payload conflicts roll back and are not acknowledged', async () => {
  const wallet = await openTestWallet(db.app),
    messageId = crypto.randomUUID();
  await enqueueWager(db, wagerCommand(wallet), messageId);
  await consumer.pollOnce();
  await enqueueWager(db, wagerCommand(wallet), messageId);
  const [poison] = await db.sqs.receive(db.queueUrl);
  const result = await Promise.allSettled([consumer.handle(db.queueUrl, poison!)]);
  expect(result[0]?.status).toBe('rejected');
  await db.sqs.changeVisibility(db.queueUrl, poison!.ReceiptHandle!, 0);
  const [again] = await db.sqs.receive(db.queueUrl);
  expect(again).toBeDefined();
  await db.sqs.delete(db.queueUrl, again!.ReceiptHandle!);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('ack observes committed Inbox/ledger; a failed delete redelivers safely', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet),
    messageId = crypto.randomUUID();
  await enqueueWager(db, command, messageId);
  const [message] = await db.sqs.receive(db.queueUrl);
  const ack = spyOn(db.sqs, 'delete').mockImplementation(async () => {
    const [row] = await db.app.query<Array<{ processed: boolean }>>(
      'SELECT processed_at IS NOT NULL AS processed FROM wagering.inbox_messages WHERE message_id=$1',
      [messageId],
    );
    expect(row?.processed).toBe(true);
    await assertWalletLedger(db.app, wallet.id, '75.00');
    throw new Error('Injected ack loss after commit');
  });
  try {
    expect((await Promise.allSettled([consumer.handle(db.queueUrl, message!)]))[0]?.status).toBe(
      'rejected',
    );
  } finally {
    ack.mockRestore();
  }
  await db.sqs.changeVisibility(db.queueUrl, message!.ReceiptHandle!, 0);
  const [again] = await db.sqs.receive(db.queueUrl);
  await consumer.handle(db.queueUrl, again!);
  expect((await counts(wallet.id))[0]?.debits).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('business rejections and durable missing references are committed before acknowledgement', async () => {
  const wallet = await openTestWallet(db.app);
  await enqueueWager(db, wagerCommand(wallet, { money: { amount: '500', currency: 'BRL' } }));
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  await enqueueWager(
    db,
    wagerCommand(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'not-yet-present',
    }),
  );
  expect((await consumer.pollOnce()).acknowledged).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('SQL failure rolls back Inbox and money before ack, then a real redelivery succeeds', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet),
    messageId = crypto.randomUUID();
  await enqueueWager(db, command, messageId);
  const [message] = await db.sqs.receive(db.queueUrl);
  await db.owner.query(
    `CREATE FUNCTION wagering.consumer_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${wallet.id}'::uuid THEN RAISE EXCEPTION 'injected SQL failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER consumer_fault BEFORE INSERT ON wagering.outbox_messages FOR EACH ROW EXECUTE FUNCTION wagering.consumer_fault()`,
  );
  const ack = spyOn(db.sqs, 'delete');
  try {
    expect((await Promise.allSettled([consumer.handle(db.queueUrl, message!)]))[0]?.status).toBe(
      'rejected',
    );
    expect(ack).not.toHaveBeenCalled();
    await assertWalletLedger(db.app, wallet.id, '100.00');
    const [row] = await db.app.query<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM wagering.inbox_messages WHERE message_id=$1',
      [messageId],
    );
    expect(row?.count).toBe(0);
  } finally {
    ack.mockRestore();
    await db.owner.query(
      'DROP TRIGGER consumer_fault ON wagering.outbox_messages; DROP FUNCTION wagering.consumer_fault()',
    );
  }
  await db.sqs.changeVisibility(db.queueUrl, message!.ReceiptHandle!, 0);
  const [again] = await db.sqs.receive(db.queueUrl);
  await consumer.handle(db.queueUrl, again!);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});
