import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { spawnWorker } from '@test/support/worker-process.util';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { readOutboxConfig } from '@/config/outbox';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
}, 180_000);
afterAll(async () => {
  await db?.close();
}, 30_000);

function spawn(overrides: NodeJS.ProcessEnv = {}) {
  const config = financialServices(db.app).config;
  return spawnWorker({
    DATABASE_URL: config.DATABASE_URL,
    AWS_ENDPOINT_URL: db.config.AWS_ENDPOINT_URL!,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
    SQS_HEARTBEAT_INTERVAL_MS: '100',
    SQS_REQUEST_TIMEOUT_MS: '500',
    WORKERS_ENABLED: 'true',
    SHUTDOWN_DRAIN_MS: '5000',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    ...overrides,
  });
}

async function sleepTrigger(walletId: string, seconds: string) {
  await db.owner.query(
    `CREATE FUNCTION wagering.shutdown_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${walletId}'::uuid THEN PERFORM pg_sleep(${seconds}); END IF; RETURN NEW; END $$; CREATE TRIGGER shutdown_pause BEFORE INSERT ON wagering.outbox_messages FOR EACH ROW EXECUTE FUNCTION wagering.shutdown_pause()`,
  );
}
const dropTrigger = () =>
  db.owner.query(
    'DROP TRIGGER shutdown_pause ON wagering.outbox_messages; DROP FUNCTION wagering.shutdown_pause()',
  );
async function inTransaction() {
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ sleeping: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event='PgSleep') AS sleeping",
    );
    return row?.sleeping === true;
  });
}

test('idle SIGTERM aborts polling and closes a real worker promptly', async () => {
  const worker = spawn();
  try {
    await worker.phase('started');
    await worker.stop();
    expect(worker.child.exitCode).toBe(0);
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
  }
});

test('visibility heartbeats protect a slow transaction and SIGTERM drains committed work before ack', async () => {
  const wallet = await openTestWallet(db.app);
  await sleepTrigger(wallet.id, '1');
  await enqueueWager(db, wagerCommand(wallet));
  const worker = spawn({
    TEST_WORKER_MODE: 'short-initial-visibility',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
  });
  try {
    await worker.phase('started');
    await inTransaction();
    // The fixture shortens the initial receipt window to one second. Heartbeats
    // restore the configured five seconds while a two-second SQL transaction runs.
    // LocalStack 4.9.2 rejects old receipts if total elapsed time exceeds its last
    // visibility duration, even after extensions; five seconds avoids that emulator bug.
    await Bun.sleep(1100);
    expect(await db.sqs.receive(db.queueUrl)).toHaveLength(0);
    expect(await db.sqs.queueDepth(db.queueUrl)).toEqual({ visible: 0, inFlight: 1 });
    await worker.stop();
    await assertWalletLedger(db.app, wallet.id, '75.00');
    if (!worker.phases.has('acked'))
      throw new Error(
        'Ack was not completed; phases=' +
          [...worker.phases].join(',') +
          ': ' +
          (await worker.diagnostics()),
      );
    await waitFor(async () => {
      const depth = await db.sqs.queueDepth(db.queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    });
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await dropTrigger();
  }
}, 15_000);

test('shutdown deadline aborts unfinished SQL and redelivery applies it once', async () => {
  const wallet = await openTestWallet(db.app);
  await sleepTrigger(wallet.id, '20');
  await enqueueWager(db, wagerCommand(wallet));
  const worker = spawn({ SHUTDOWN_DRAIN_MS: '100', DATABASE_TRANSACTION_TIMEOUT_MS: '1500' });
  try {
    await worker.phase('started');
    await inTransaction();
    await worker.stop(1);
    await assertWalletLedger(db.app, wallet.id, '100.00');
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    await dropTrigger();
  }
  const consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, db.config);
  await waitFor(async () => (await consumer.pollOnce()).acknowledged === 1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 15_000);

test('deadline after commit but before ack releases the receipt and durable replay avoids another debit', async () => {
  const wallet = await openTestWallet(db.app);
  await enqueueWager(db, wagerCommand(wallet));
  const worker = spawn({ TEST_WORKER_MODE: 'hold-before-ack', SHUTDOWN_DRAIN_MS: '100' });
  try {
    await worker.phase('before-ack');
    await worker.stop(1);
    await assertWalletLedger(db.app, wallet.id, '75.00');
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
  }
  const consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, db.config);
  await waitFor(async () => (await consumer.pollOnce()).acknowledged === 1);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('deadline during publication leaves an expiring claim that another publisher completes', async () => {
  const wallet = await openTestWallet(db.app);
  const worker = spawn({
    TEST_WORKER_MODE: 'hold-after-publish',
    SHUTDOWN_DRAIN_MS: '100',
    OUTBOX_BATCH_SIZE: '1',
    OUTBOX_LEASE_MS: '100',
  });
  try {
    await worker.phase('after-publish');
    await worker.stop(1);
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
  }
  const publisher = new OutboxPublisher(
    db.app,
    financialServices(db.app).config,
    db.sqs,
    readOutboxConfig({}),
  );
  await publisher.runOnce();
  const [row] = await db.app.query<Array<{ remaining: number }>>(
    'SELECT count(*)::int AS remaining FROM wagering.outbox_messages WHERE aggregate_id=$1 AND published_at IS NULL',
    [wallet.id],
  );
  expect(row?.remaining).toBe(0);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});
