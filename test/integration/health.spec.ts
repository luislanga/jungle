import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { startMessagingTest } from '@test/support/messaging.util';
import { startHttpTest } from '@test/support/http.util';
import { assertWalletLedger, openTestWallet, waitFor } from '@test/support/financial.util';
import { OUTBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';

let db: Awaited<ReturnType<typeof startMessagingTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>,
  walletId: string;
beforeAll(async () => {
  db = await startMessagingTest();
  http = await startHttpTest(db.app, db.sqs);
  walletId = (await openTestWallet(db.app)).id;
}, 180_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);
async function healthy() {
  await waitFor(async () => (await http.request('/health/ready')).status === 200);
}

async function snapshot() {
  return db.owner.query<
    unknown[]
  >(`SELECT (SELECT count(*) FROM wagering.wallets) AS wallets,(SELECT count(*) FROM wagering.wager_transactions) AS wagers,
    (SELECT count(*) FROM wagering.wallet_ledger_entries) AS ledger,(SELECT count(*) FROM wagering.inbox_messages) AS inbox,(SELECT count(*) FROM wagering.outbox_messages) AS outbox`);
}

test('public live/ready are separate and repeated probes never write financial data or receive messages', async () => {
  await db.sqs.send(
    db.queueUrl,
    'health-must-not-consume',
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
  const before = await snapshot();
  expect(await (await http.request('/health/live')).json()).toEqual({ status: 'ok' });
  const response = await http.request('/health/ready');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: true, sqs: true } });
  expect(await snapshot()).toEqual(before);
  expect((await db.sqs.queueDepth(db.queueUrl)).visible).toBe(1);
  await assertWalletLedger(db.app, walletId, '100.00');
});

test('database connection outage fails readiness while liveness remains public and succeeds', async () => {
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
    expect((await http.request('/health/live')).status).toBe(200);
    const response = await http.request('/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: false, sqs: true },
    });
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
  await healthy();
  await assertWalletLedger(db.app, walletId, '100.00');
});

test('a missing named queue fails readiness even when its URL was previously cached, then recovers', async () => {
  await db.sqs.client.send(
    new DeleteQueueCommand({ QueueUrl: await db.sqs.queueUrl(OUTBOUND_QUEUE_NAME) }),
  );
  try {
    expect((await http.request('/health/live')).status).toBe(200);
    const response = await http.request('/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: true, sqs: false },
    });
  } finally {
    await db.run(['run', '--rm', 'queue-init']);
  }
  await healthy();
  await assertWalletLedger(db.app, walletId, '100.00');
}, 30_000);

test('an unresponsive real SQS service hits the readiness response deadline and later recovers', async () => {
  const before = await snapshot();
  try {
    await db.run(['pause', 'localstack']);
    const start = performance.now();
    const response = await http.request('/health/ready');
    expect(response.status).toBe(503);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: true, sqs: false },
    });
    expect((await http.request('/health/live')).status).toBe(200);
  } finally {
    await db.run(['unpause', 'localstack']);
  }
  await healthy();
  expect(await snapshot()).toEqual(before);
  const [message] = await db.sqs.receive(db.queueUrl);
  expect(message?.Body).toBe('health-must-not-consume');
  expect(message?.Attributes?.ApproximateReceiveCount).toBe('1');
  await db.sqs.delete(db.queueUrl, message!.ReceiptHandle!);
  await assertWalletLedger(db.app, walletId, '100.00');
}, 15_000);

test('a paused PostgreSQL server hits the deadline without borrowing financial pool connections', async () => {
  try {
    await db.run(['pause', 'postgres']);
    expect((await http.request('/health/live')).status).toBe(200);
    const start = performance.now();
    const response = await http.request('/health/ready');
    expect(response.status).toBe(503);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: false, sqs: true },
    });
  } finally {
    await db.run(['unpause', 'postgres']);
  }
  await healthy();
  await assertWalletLedger(db.app, walletId, '100.00');
}, 15_000);
