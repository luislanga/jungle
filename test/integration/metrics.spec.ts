import {
  createPendingWorkStore,
  createOutboxStore,
} from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startMessagingTest } from '@test/support/messaging.util';
import { startHttpTest } from '@test/support/http.util';
import {
  assertWalletLedger,
  failureOf,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { withTransaction } from '@/database/transaction';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';
import { DEAD_LETTER_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import {
  OUTCOME_COUNT,
  OUTBOX_LAG,
  DUPLICATE_COUNT,
  LOCK_CONFLICT_COUNT,
  RETRY_COUNT,
  METRICS_REGISTRY,
} from '@/shared/infrastructure/metrics/metrics';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';

let db: Awaited<ReturnType<typeof startMessagingTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
  http = await startHttpTest(db.app, db.sqs);
}, 180_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

async function counter(
  counter: typeof DUPLICATE_COUNT | typeof OUTCOME_COUNT | typeof RETRY_COUNT,
  label?: string,
) {
  const values = (await counter.get()).values;
  return values
    .filter((value) => label === undefined || Object.values(value.labels).includes(label))
    .reduce((sum, value) => sum + value.value, 0);
}

test('real transitions/replays/retries, lock conflicts, latency, Outbox lag, DLQ and reconciliation are observable with bounded labels', async () => {
  const wallet = await openTestWallet(db.app),
    service = financialServices(db.app).process,
    command = wagerCommand(wallet);
  const processed = await counter(OUTCOME_COUNT, 'PROCESSED'),
    duplicates = await counter(DUPLICATE_COUNT);
  await service.execute(command, TEST_CONTEXT);
  await service.execute(command, TEST_CONTEXT);
  expect(await counter(OUTCOME_COUNT, 'PROCESSED')).toBe(processed + 1);
  expect(await counter(DUPLICATE_COUNT)).toBe(duplicates + 1);
  await service.execute(
    wagerCommand(wallet, { money: { amount: '500', currency: 'BRL' } }),
    TEST_CONTEXT,
  );
  const pending = await service.execute(
    wagerCommand(wallet, { kind: Kind.Refund, referenceExternalTransactionId: 'missing' }),
    TEST_CONTEXT,
  );
  await db.owner.query(
    'UPDATE wagering.pending_reference_work SET next_attempt_at=now() WHERE transaction_id=$1',
    [pending.transactionId],
  );
  const pendingOutcomes = await counter(OUTCOME_COUNT, 'PENDING_REFERENCE');
  await new PendingReferenceResolver(
    createPendingWorkStore(db.app, financialServices(db.app).config),
    service,
  ).runOnce();
  expect(await counter(RETRY_COUNT, 'pending_reference')).toBeGreaterThan(0);
  expect(await counter(OUTCOME_COUNT, 'PENDING_REFERENCE')).toBe(pendingOutcomes);
  const blocker = db.app.createQueryRunner();
  await blocker.startTransaction();
  await blocker.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [wallet.id]);
  const locks = await counter(LOCK_CONFLICT_COUNT),
    retries = await counter(RETRY_COUNT, 'database');
  try {
    expect(
      await failureOf(
        withTransaction(
          db.app,
          {
            ...financialServices(db.app).config,
            DATABASE_LOCK_TIMEOUT_MS: 25,
            DATABASE_TRANSACTION_MAX_ATTEMPTS: 2,
          },
          (manager) =>
            manager.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [
              wallet.id,
            ]),
        ),
      ),
    ).toBeInstanceOf(Error);
  } finally {
    await blocker.rollbackTransaction();
    await blocker.release();
  }
  expect(await counter(LOCK_CONFLICT_COUNT)).toBe(locks + 2);
  expect(await counter(RETRY_COUNT, 'database')).toBe(retries + 1);
  const consumer = new SqsWagerConsumer(db.sqs, service, {
    ...db.config,
    SQS_RETRY_BASE_SECONDS: 0,
    SQS_RETRY_MAX_SECONDS: 0,
  });
  await db.sqs.send(
    db.queueUrl,
    'metric-poison',
    crypto.randomUUID(),
    crypto.randomUUID()
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const [message] = await db.sqs.receive(db.queueUrl);
    await failureOf(consumer.handle(db.queueUrl, message!));
  }
  await db.sqs.receive(db.queueUrl);
  const dlq = await db.sqs.queueUrl(DEAD_LETTER_QUEUE_NAME);
  await waitFor(async () => (await db.sqs.queueDepth(dlq)).visible === 1);
  const before = await http.request('/metrics');
  const text = await before.text();
  expect(before.status).toBe(200);
  expect(before.headers.get('content-type')).toContain('text/plain');
  expect(text).toContain('wager_dlq_messages 1');
  expect((await OUTBOX_LAG.get()).values[0]?.value).toBeGreaterThan(0);
  expect(text).toContain('wager_processing_duration_seconds_count{operation="submit"}');
  expect((await db.sqs.queueDepth(dlq)).visible).toBe(1);
  expect(await counter(RETRY_COUNT, 'sqs')).toBeGreaterThanOrEqual(5);
  const publish = new OutboxPublisher(
    createOutboxStore(db.app, financialServices(db.app).config),
    db.sqs,
  );
  const sends = spyOn(db.sqs, 'send').mockRejectedValueOnce(new Error('Injected send failure'));
  try {
    await publish.runOnce();
  } finally {
    sends.mockRestore();
  }
  expect(await counter(RETRY_COUNT, 'outbox')).toBeGreaterThan(0);
  await db.owner.query(
    'UPDATE wagering.wallets SET balance=76,version=version+1,updated_at=now() WHERE id=$1',
    [wallet.id],
  );
  expect(
    (await http.request(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).status,
  ).toBe(200);
  expect(await (await http.request('/metrics')).text()).toContain(
    'wager_reconciliation_discrepancies 1',
  );
  await db.owner.query(
    'UPDATE wagering.wallets SET balance=75,version=version+1,updated_at=now() WHERE id=$1',
    [wallet.id],
  );
  await assertWalletLedger(db.app, wallet.id, '75.00');
  const metrics = await METRICS_REGISTRY.getMetricsAsJSON();
  for (const metric of metrics)
    for (const value of metric.values) {
      expect(
        Object.keys(value.labels).every((key) =>
          ['status', 'source', 'operation', 'dependency', 'le'].includes(key),
        ),
      ).toBe(true);
      expect(Object.values(value.labels)).not.toContain(wallet.id);
    }
}, 20_000);
