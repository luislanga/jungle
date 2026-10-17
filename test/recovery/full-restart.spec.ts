import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  openTestWallet,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { jsonRequest } from '@test/support/http.util';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import type {
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';
import type { ReconciliationResult } from '@/shared/interfaces/wallet.interface';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
const SERVICES = ['app', 'app2', 'app3'];
let urls: string[] = [];
async function ready() {
  urls = await Promise.all(
    SERVICES.map(async (name) => 'http://' + (await db.run(['port', name, '3000'])).trim()),
  );
  await waitFor(async () => {
    try {
      return (await Promise.all(urls.map((url) => fetch(url + '/health/ready')))).every(
        (r) => r.status === 200,
      );
    } catch {
      return false;
    }
  }, 30000);
}
beforeAll(async () => {
  db = await startMessagingTest();
  await db.run(['up', '--build', '--detach', ...SERVICES]);
  await ready();
}, 300000);
afterAll(async () => {
  if (db) {
    try {
      await Bun.write('/tmp/t37-compose.log', await db.run(['logs', '--no-color', ...SERVICES]));
    } finally {
      await db.close();
    }
  }
}, 45000);
async function submit(command: WagerCommand, index = 0, expected = 200) {
  const response = await fetch(urls[index] + '/wagering/transactions', {
    ...jsonRequest(command.data),
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
  });
  expect(response.status).toBe(expected);
  return (await response.json()) as WagerProcessingResult;
}
async function processed(key: string) {
  // A stopped long poll can leave a delivery invisible for the configured 30 seconds.
  // Allow that receipt window plus worker polling; durable replay still decides correctness.
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ status: string }>>(
      'SELECT status FROM wagering.wager_transactions WHERE idempotency_key=$1',
      [key],
    );
    return row?.status === 'PROCESSED';
  }, 60000);
}

test('three production applications restart over retained work and recover PostgreSQL/SQS outages', async () => {
  const beforeProcesses = await db.run(['top', ...SERVICES]);
  expect(beforeProcesses.split('bun dist/main.js').length - 1).toBe(3);
  const walletA = await openTestWallet(db.app);
  const walletB = await openTestWallet(db.app);
  const bet = wagerCommand(walletA);
  const original = await submit(bet);
  expect(original.balance.amount).toBe('75.00');
  const win = wagerCommand(walletA, {
    kind: Kind.Win,
    money: { amount: '10.00', currency: 'BRL' },
  });
  const winMessageId = crypto.randomUUID();
  await enqueueWager(db, win, winMessageId);
  await processed(win.idempotencyKey);
  console.log(JSON.stringify({ event: 'restart_test_stage', stage: 'initial-sqs-processed' }));
  await submit(
    wagerCommand(walletA, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }),
    1,
  );
  const lateBet = wagerCommand(walletB);
  const refund = wagerCommand(walletB, {
    kind: Kind.Refund,
    referenceExternalTransactionId: lateBet.data.externalTransactionId,
  });
  await submit(refund, 2, 202);
  const pendingBefore = await db.app.query<Array<{ expires_at: Date }>>(
    'SELECT p.expires_at FROM wagering.pending_reference_work p JOIN wagering.wager_transactions t ON t.id=p.transaction_id WHERE t.idempotency_key=$1',
    [refund.idempotencyKey],
  );
  expect(pendingBefore).toHaveLength(1);
  // Pausing preserves the broker's queue state while simulating a temporary outage.
  // Recreating this LocalStack container would discard its in-memory queues.
  try {
    await db.run(['pause', 'localstack']);
    expect((await fetch(urls[0] + '/health/live')).status).toBe(200);
    expect((await fetch(urls[0] + '/health/ready')).status).toBe(503);
    const duringOutage = await submit(
      wagerCommand(walletA, { money: { amount: '5.00', currency: 'BRL' } }),
    );
    expect(duringOutage.balance.amount).toBe('80.00');
    const [retained] = await db.app.query<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM wagering.outbox_messages WHERE published_at IS NULL',
    );
    expect(retained!.count).toBeGreaterThan(0);
    await db.run(['stop', ...SERVICES]);
    console.log(JSON.stringify({ event: 'restart_test_stage', stage: 'applications-stopped' }));
  } finally {
    await db.run(['unpause', 'localstack']);
  }
  const durableEvents = await db.app.query<Array<{ id: string; payload: unknown }>>(
    'SELECT id,payload FROM wagering.outbox_messages ORDER BY id',
  );
  expect(
    await db.app.query<Array<{ expires_at: Date }>>(
      'SELECT p.expires_at FROM wagering.pending_reference_work p JOIN wagering.wager_transactions t ON t.id=p.transaction_id WHERE t.idempotency_key=$1',
      [refund.idempotencyKey],
    ),
  ).toEqual(pendingBefore);
  await assertWalletLedger(db.app, walletA.id, '80.00');
  await assertWalletLedger(db.app, walletB.id, '100.00');
  await enqueueWager(db, lateBet);
  const duplicateMessageId = crypto.randomUUID();
  await enqueueWager(db, bet, duplicateMessageId);
  await db.run(['start', ...SERVICES]);
  console.log(JSON.stringify({ event: 'restart_test_stage', stage: 'applications-restarted' }));
  await ready();
  const afterProcesses = await db.run(['top', ...SERVICES]);
  expect(afterProcesses.split('bun dist/main.js').length - 1).toBe(3);
  expect(afterProcesses).not.toBe(beforeProcesses);
  await Bun.write(
    '/tmp/t37-container-processes.txt',
    beforeProcesses + '\nRESTARTED\n' + afterProcesses,
  );
  await processed(lateBet.idempotencyKey);
  console.log(JSON.stringify({ event: 'restart_test_stage', stage: 'late-bet-processed' }));
  await processed(refund.idempotencyKey);
  for (let index = 0; index < 3; index++)
    expect(await submit(bet, index)).toEqual({ ...original, idempotentReplay: true });
  // An actual PostgreSQL pause affects readiness and work, then the same processes recover.
  const postRestartWin = wagerCommand(walletB, {
    kind: Kind.Win,
    money: { amount: '1.00', currency: 'BRL' },
  });
  try {
    await db.run(['pause', 'postgres']);
    expect((await fetch(urls[1] + '/health/live')).status).toBe(200);
    expect((await fetch(urls[1] + '/health/ready')).status).toBe(503);
    await enqueueWager(db, postRestartWin);
    await waitFor(async () => (await db.sqs.queueDepth(db.queueUrl)).inFlight > 0);
  } finally {
    await db.run(['unpause', 'postgres']);
  }
  await ready();
  await processed(postRestartWin.idempotencyKey);
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ remaining: number }>>(
      'SELECT count(*)::int AS remaining FROM wagering.outbox_messages WHERE published_at IS NULL',
    );
    const queue = await db.sqs.queueDepth(db.queueUrl);
    return row?.remaining === 0 && queue.visible === 0 && queue.inFlight === 0;
  }, 30000);
  for (const [wallet, amount] of [
    [walletA, '80.00'],
    [walletB, '101.00'],
  ] as const) {
    await assertWalletLedger(db.app, wallet.id, amount);
    expect(
      await db.app.query<Array<{ version: number; ledger: number; events: number }>>(
        `SELECT w.version,
      (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
      (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=w.id) AS events FROM wagering.wallets w WHERE id=$1`,
        [wallet.id],
      ),
    ).toEqual([{ version: 4, ledger: 4, events: 9 }]);
    for (const url of urls) {
      const reconciliation = await fetch(url + '/wallets/' + wallet.id + '/reconciliation', {
        method: 'POST',
      });
      expect((await reconciliation.json()) as ReconciliationResult).toMatchObject({
        consistent: true,
        checkedEntries: 4,
        storedBalance: { amount, currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
      });
    }
  }
  expect(
    await db.app.query<Array<{ id: string; payload: unknown }>>(
      'SELECT id,payload FROM wagering.outbox_messages WHERE id=ANY($1::uuid[]) ORDER BY id',
      [durableEvents.map((e) => e.id)],
    ),
  ).toEqual(durableEvents);
  expect(
    await db.app.query<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM wagering.inbox_messages WHERE message_id=ANY($1::text[]) AND processed_at IS NOT NULL',
      [[winMessageId, duplicateMessageId]],
    ),
  ).toEqual([{ count: 2 }]);
  expect(
    await db.app.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM wagering.wager_transactions WHERE status IN ('FAILED','PENDING_REFERENCE')",
    ),
  ).toEqual([{ count: 0 }]);
}, 180000);
