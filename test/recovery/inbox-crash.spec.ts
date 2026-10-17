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

let db: Awaited<ReturnType<typeof startMessagingTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
}, 180000);
afterAll(async () => {
  await db?.close();
}, 30000);

function spawn(overrides: NodeJS.ProcessEnv = {}) {
  return spawnWorker({
    DATABASE_URL: financialServices(db.app).config.DATABASE_URL,
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
async function kill(worker: ReturnType<typeof spawn>) {
  console.log(JSON.stringify({ event: 'inbox_worker_sigkill', pid: worker.child.pid }));
  worker.child.kill('SIGKILL');
  await waitFor(() => worker.child.exitCode !== null || worker.child.signalCode !== null);
  await worker.child.exited;
  expect(worker.child.signalCode).toBe('SIGKILL');
}
async function verify(walletId: string, messageId: string, committed: boolean) {
  await assertWalletLedger(db.app, walletId, committed ? '75.00' : '100.00');
  const [row] = await db.app.query<
    Array<{
      version: number;
      wagers: number;
      ledger: number;
      events: number;
      inbox: number;
    }>
  >(
    `SELECT w.version,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=w.id) AS wagers,
    (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=w.id) AS events,
    (SELECT count(*)::int FROM wagering.inbox_messages WHERE message_id=$2 AND processed_at IS NOT NULL) AS inbox
    FROM wagering.wallets w WHERE w.id=$1`,
    [walletId, messageId],
  );
  expect(row).toEqual(
    committed
      ? {
          version: 2,
          wagers: 2,
          ledger: 2,
          events: 4,
          inbox: 1,
        }
      : {
          version: 1,
          wagers: 1,
          ledger: 1,
          events: 2,
          inbox: 0,
        },
  );
}
async function recovered() {
  const replacement = spawn();
  try {
    await replacement.phase('acked');
    await replacement.stop();
    await waitFor(async () => {
      const depth = await db.sqs.queueDepth(db.queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    });
  } finally {
    if (replacement.child.exitCode === null) {
      replacement.child.kill('SIGKILL');
      await replacement.child.exited;
    }
  }
}

test('SIGKILL after commit before ack preserves Inbox and original result across replacement and new transport IDs', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const messageId = crypto.randomUUID();
  await enqueueWager(db, command, messageId);
  const worker = spawn({ TEST_WORKER_MODE: 'hold-before-ack' });
  try {
    await worker.phase('before-ack');
    await verify(wallet.id, messageId, true);
    await kill(worker);
    await recovered();
    await verify(wallet.id, messageId, true);
    // SendMessage creates another SQS transport identity while retaining the envelope identity.
    await enqueueWager(db, command, messageId);
    await recovered();
    await verify(wallet.id, messageId, true);
    const replay = await financialServices(db.app).process.execute(command, {
      correlationId: 'crash-replay',
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('75.00');
  } finally {
    if (worker.child.exitCode === null) {
      worker.child.kill('SIGKILL');
      await worker.child.exited;
    }
  }
}, 20000);

test('SIGKILL before commit rolls back every write and a replacement applies the original envelope once', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const messageId = crypto.randomUUID();
  // Only this disposable database has a pause trigger; the runtime image has no crash hooks.
  await db.owner.query(
    `CREATE FUNCTION wagering.inbox_crash_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_id='${wallet.id}'::uuid THEN PERFORM pg_sleep(20); END IF; RETURN NEW; END $$; CREATE TRIGGER inbox_crash_pause BEFORE INSERT ON wagering.outbox_messages FOR EACH ROW EXECUTE FUNCTION wagering.inbox_crash_pause()`,
  );
  await enqueueWager(db, command, messageId);
  const worker = spawn({ DATABASE_TRANSACTION_TIMEOUT_MS: '1500' });
  try {
    await worker.phase('started');
    await waitFor(async () => {
      const [row] = await db.app.query<Array<{ sleeping: boolean }>>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event='PgSleep') AS sleeping",
      );
      return row?.sleeping === true;
    });
    await verify(wallet.id, messageId, false);
    await kill(worker);
  } finally {
    if (worker.child.exitCode === null) {
      worker.child.kill('SIGKILL');
      await worker.child.exited;
    }
    // PostgreSQL's transaction timeout bounds cleanup if a dead socket is noticed after pg_sleep.
    await db.owner.query(
      'DROP TRIGGER inbox_crash_pause ON wagering.outbox_messages; DROP FUNCTION wagering.inbox_crash_pause()',
    );
  }
  await verify(wallet.id, messageId, false);
  await recovered();
  await verify(wallet.id, messageId, true);
}, 20000);
