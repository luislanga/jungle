import { createOutboxStore } from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startMessagingTest } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { SqsGateway } from '@/modules/messaging/infrastructure/sqs/sqs.gateway';
import { readOutboxConfig } from '@/config/outbox';
import { OUTBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

let db: Awaited<ReturnType<typeof startMessagingTest>>, outbound: string;
beforeAll(async () => {
  db = await startMessagingTest();
  outbound = await db.sqs.queueUrl(OUTBOUND_QUEUE_NAME);
}, 180_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const publisher = (batch = 20, sqs = db.sqs) =>
  new OutboxPublisher(
    createOutboxStore(db.app, financialServices(db.app).config),
    sqs,
    readOutboxConfig({ OUTBOX_BATCH_SIZE: String(batch) }),
  );

async function drain(count: number, sqs = db.sqs) {
  const items: EventEnvelope[] = [];
  const url = await sqs.queueUrl(OUTBOUND_QUEUE_NAME);
  await waitFor(async () => {
    for (const message of await sqs.receive(url)) {
      items.push(JSON.parse(message.Body!) as EventEnvelope);
      await sqs.delete(url, message.ReceiptHandle!);
    }
    return items.length >= count;
  });
  return items;
}

test('two publishers claim disjoint batches and release SQL locks before real sends', async () => {
  const wallet = await openTestWallet(db.app);
  await financialServices(db.app).process.execute(wagerCommand(wallet), TEST_CONTEXT);
  const original = db.sqs.send.bind(db.sqs);
  const sends = spyOn(db.sqs, 'send').mockImplementation(async (
    queue,
    body,
    group,
    dedup
  ) => {
    // A separate connection can lock the claimed row while the send is in flight.
    await db.app.transaction(async (manager) => {
      await manager.query('SELECT id FROM wagering.outbox_messages WHERE id=$1 FOR UPDATE NOWAIT', [
        dedup,
      ]);
    });
    return original(
      queue,
      body,
      group,
      dedup
    );
  });
  let results: Awaited<ReturnType<OutboxPublisher['runOnce']>>[];
  try {
    results = await Promise.all([publisher(2).runOnce(), publisher(2).runOnce()]);
  } finally {
    sends.mockRestore();
  }
  expect(results.map((result) => result.claimed).sort()).toEqual([2, 2]);
  expect(results.reduce((sum, result) => sum + result.published, 0)).toBe(4);
  const events = await drain(4);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(4);
  expect(events.every((event) => event.version === 1 && event.aggregateId === wallet.id)).toBe(
    true,
  );
  expect(events.some((event) => JSON.stringify(event.data).includes('75.00'))).toBe(true);
  expect(await publisher().runOnce()).toEqual({ claimed: 0, published: 0 });
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('uncommitted Outbox rows are invisible to publishers', async () => {
  const wallet = await openTestWallet(db.app);
  await publisher().runOnce();
  await drain(2);
  const runner = db.app.createQueryRunner();
  await runner.startTransaction();
  try {
    const id = crypto.randomUUID();
    await runner.query(
      `INSERT INTO wagering.outbox_messages(id,aggregate_id,event_type,payload,occurred_at)
      SELECT $1::uuid,aggregate_id,event_type,jsonb_set(payload,'{eventId}',to_jsonb($1::text)),occurred_at FROM wagering.outbox_messages WHERE aggregate_id=$2 LIMIT 1`,
      [id, wallet.id],
    );
    expect(await publisher().runOnce()).toEqual({ claimed: 0, published: 0 });
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('expired publisher claims are recovered and stale completion is fenced', async () => {
  const wallet = await openTestWallet(db.app);
  const [old] = await db.app.transaction((manager) =>
    new OutboxMessageRepository(manager).claimDue({
      owner: 'crashed-publisher',
      limit: 1,
      leaseMs: 30000,
    }),
  );
  await db.owner.query(
    "UPDATE wagering.outbox_messages SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old!.message.id],
  );
  expect((await publisher().runOnce()).published).toBe(2);
  expect(
    await db.app.transaction((manager) =>
      new OutboxMessageRepository(manager).markPublished(old!.message.id, old!.token),
    ),
  ).toBe(false);
  await drain(2);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('send-before-mark failure retries the same eventId and a durable downstream sink deduplicates actual deliveries', async () => {
  const wallet = await openTestWallet(db.app);
  const mark = spyOn(OutboxMessageRepository.prototype, 'markPublished').mockRejectedValueOnce(
    new Error('Injected failure after broker accepted send'),
  );
  try {
    expect((await publisher(1).runOnce()).published).toBe(0);
  } finally {
    mark.mockRestore();
  }
  const first = await drain(1);
  await db.owner.query(
    'UPDATE wagering.outbox_messages SET next_attempt_at=now() WHERE published_at IS NULL',
  );
  expect((await publisher().runOnce()).published).toBe(2);
  const rest = await drain(1); // FIFO suppresses the first event's immediate duplicate.
  // Republish with fresh transport dedup IDs to represent delivery after FIFO's
  // short dedup window. Stable eventId remains the consumer's durable identity.
  await db.sqs.send(
    outbound,
    JSON.stringify(first[0]),
    wallet.id,
    crypto.randomUUID()
  );
  await db.sqs.send(
    outbound,
    JSON.stringify(first[0]),
    wallet.id,
    crypto.randomUUID()
  );
  const duplicates = await drain(2);
  expect(duplicates.map((event) => event.eventId)).toEqual([first[0]!.eventId, first[0]!.eventId]);
  await db.owner.query('CREATE TABLE wagering.downstream_test_inbox(event_id uuid PRIMARY KEY)');
  for (const event of [...first, ...rest, ...duplicates])
    await db.owner.query(
      'INSERT INTO wagering.downstream_test_inbox VALUES($1) ON CONFLICT DO NOTHING',
      [event.eventId],
    );
  const [row] = await db.owner.query<Array<{ count: number }>>(
    'SELECT count(*)::int AS count FROM wagering.downstream_test_inbox',
  );
  expect(row?.count).toBe(2);
  expect(await publisher().runOnce()).toEqual({ claimed: 0, published: 0 });
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('real broker outage persists retries beyond escalation and recovery publishes retained events', async () => {
  const wallet = await openTestWallet(db.app);
  const worker = publisher();
  // Cache the real URL before disconnecting; subsequent sends hit the unavailable broker.
  await db.sqs.queueUrl(OUTBOUND_QUEUE_NAME);
  await db.owner.query(
    'UPDATE wagering.outbox_messages SET attempts=10 WHERE published_at IS NULL',
  );
  let recovered: SqsGateway | undefined;
  try {
    await db.run(['stop', 'localstack']);
    expect(await worker.runOnce()).toEqual({ claimed: 2, published: 0 });
    const rows = await db.app.query<Array<{ attempts: number; retained: boolean }>>(
      'SELECT attempts,published_at IS NULL AND next_attempt_at IS NOT NULL AS retained FROM wagering.outbox_messages WHERE aggregate_id=$1',
      [wallet.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.attempts === 11 && row.retained)).toBe(true);
  } finally {
    await db.run(['run', '--rm', 'queue-init']);
    const address = (await db.run(['port', 'localstack', '4566'])).trim();
    recovered = new SqsGateway({ ...db.config, AWS_ENDPOINT_URL: 'http://' + address });
  }
  try {
    await db.owner.query(
      'UPDATE wagering.outbox_messages SET next_attempt_at=now() WHERE published_at IS NULL',
    );
    expect((await publisher(20, recovered).runOnce()).published).toBe(2);
    expect(await drain(2, recovered)).toHaveLength(2);
  } finally {
    recovered.close();
  }
  await assertWalletLedger(db.app, wallet.id, '100.00');
}, 90_000);
