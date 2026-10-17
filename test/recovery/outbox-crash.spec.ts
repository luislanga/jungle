import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { spawnWorker } from '@test/support/worker-process.util';
import { consumeEvents } from '@test/support/deduplicating-event-sink.util';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { OUTBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import { createDatabaseDataSource } from '@/database/data-source';
import { DATABASE_ENTITIES } from '@/database/entities';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
let outbound: string;
beforeAll(async () => {
  db = await startMessagingTest();
  outbound = await db.sqs.queueUrl(OUTBOUND_QUEUE_NAME);
  await db.owner.query(
    'CREATE TABLE wagering.test_event_effects(event_id uuid PRIMARY KEY,aggregate_id uuid NOT NULL,payload jsonb NOT NULL)',
  );
}, 180000);
afterAll(async () => {
  await db?.close();
}, 30000);
function spawn(mode?: string) {
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
    OUTBOX_BATCH_SIZE: '1',
    OUTBOX_LEASE_MS: '3000',
    ...(mode ? { TEST_WORKER_MODE: mode } : { TEST_WORKER_MODE: '' }),
  });
}
async function pending(walletId: string) {
  const [row] = await db.app.query<Array<{ remaining: number }>>(
    'SELECT count(*)::int AS remaining FROM wagering.outbox_messages WHERE aggregate_id=$1 AND published_at IS NULL',
    [walletId],
  );
  return row!.remaining;
}
for (const mode of ['hold-before-publish', 'hold-after-publish'] as const) {
  test(`two publisher processes recover SIGKILL ${mode} without losing events`, async () => {
    const wallet = await openTestWallet(db.app);
    await financialServices(db.app).process.execute(wagerCommand(wallet), TEST_CONTEXT);
    const workers = [spawn(mode), spawn(mode)];
    let claims: Array<{ id: string; claim_token: string }>;
    try {
      await Promise.all(
        workers.map((worker) =>
          worker.phase(mode === 'hold-before-publish' ? 'before-publish' : 'after-publish'),
        ),
      );
      console.log(
        JSON.stringify({
          event: 'publisher_sigkill_barrier',
          mode,
          pids: workers.map((w) => w.child.pid),
        }),
      );
      claims = await db.app.query<Array<{ id: string; claim_token: string }>>(
        'SELECT id,claim_token FROM wagering.outbox_messages WHERE aggregate_id=$1 AND claim_token IS NOT NULL',
        [wallet.id],
      );
      expect(claims).toHaveLength(2);
      expect(new Set(claims.map((c) => c.claim_token)).size).toBe(2);
      expect(await pending(wallet.id)).toBe(4);
      if (mode === 'hold-before-publish')
        expect(await db.sqs.queueDepth(outbound)).toEqual({ visible: 0, inFlight: 0 });
      for (const worker of workers) worker.child.kill('SIGKILL');
      await Promise.all(workers.map((w) => w.child.exited));
      for (const worker of workers) expect(worker.child.signalCode).toBe('SIGKILL');
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
      await Promise.all(workers.map((w) => w.child.exited));
    }
    // Wait for the persisted lease clock rather than clearing claims in the fixture.
    await waitFor(async () => {
      const [row] = await db.app.query<Array<{ active: number }>>(
        'SELECT count(*)::int AS active FROM wagering.outbox_messages WHERE aggregate_id=$1 AND claim_until>clock_timestamp()',
        [wallet.id],
      );
      return row?.active === 0;
    });
    const replacements = [spawn(), spawn()];
    try {
      await Promise.all(replacements.map((w) => w.phase('started')));
      await waitFor(async () => (await pending(wallet.id)) === 0, 10000);
      await Promise.all(replacements.map((w) => w.stop()));
    } finally {
      for (const worker of replacements)
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
      await Promise.all(replacements.map((w) => w.child.exited));
    }
    for (const claim of claims)
      expect(
        await db.app.transaction((manager) =>
          new OutboxMessageRepository(manager).markPublished(claim.id, claim.claim_token),
        ),
      ).toBe(false);
    const deliveries = await consumeEvents(
      db.app,
      db.sqs,
      outbound,
      4
    );
    expect(new Set(deliveries.map((e) => e.eventId)).size).toBe(4);
    const stored = await db.app.query<Array<{ id: string; payload: EventEnvelope }>>(
      'SELECT id,payload FROM wagering.outbox_messages WHERE aggregate_id=$1 ORDER BY id',
      [wallet.id],
    );
    expect(stored.map((s) => s.id).sort()).toEqual(deliveries.map((e) => e.eventId).sort());
    // Fresh transport IDs force equivalent duplicate deliveries without waiting five minutes.
    // eventId remains unchanged, just as on a publication retry beyond FIFO's dedup window.
    for (const row of stored)
      for (let copy = 0; copy < 2; copy++)
        await db.sqs.send(
          outbound,
          JSON.stringify(row.payload),
          wallet.id,
          crypto.randomUUID()
        );
    const restartedSink = await createDatabaseDataSource(
      financialServices(db.app).config,
      DATABASE_ENTITIES,
    ).initialize();
    try {
      expect(await consumeEvents(
        restartedSink,
        db.sqs,
        outbound,
        8
      )).toHaveLength(8);
    } finally {
      await restartedSink.destroy();
    }
    expect(
      await db.app.query<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM wagering.test_event_effects WHERE aggregate_id=$1',
        [wallet.id],
      ),
    ).toEqual([{ count: 4 }]);
    expect(
      await db.app.query<Array<{ version: number }>>(
        'SELECT version FROM wagering.wallets WHERE id=$1',
        [wallet.id],
      ),
    ).toEqual([{ version: 2 }]);
    await assertWalletLedger(db.app, wallet.id, '75.00');
  }, 30000);
}
