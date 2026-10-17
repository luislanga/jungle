import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import { assertWalletLedger, wagerCommand, waitFor } from '@test/support/financial.util';
import { jsonRequest } from '@test/support/http.util';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import { OUTBOUND_QUEUE_NAME } from '@/shared/consts/messaging.constant';
import type {
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
const URLS: string[] = [];
beforeAll(async () => {
  db = await startMessagingTest();
  await db.run(['up', '--build', '--detach', 'app', 'app2', 'app3']);
  for (const name of ['app', 'app2', 'app3']) {
    const address = (await db.run(['port', name, '3000'])).trim();
    URLS.push('http://' + address);
  }
  await waitFor(async () => {
    try {
      return (await Promise.all(URLS.map((url) => fetch(url)))).every(
        (response) => response.status === 404,
      );
    } catch {
      return false;
    }
  }, 30000);
}, 300_000);
afterAll(async () => {
  await db?.close();
}, 45_000);

async function submit(url: string, command: WagerCommand) {
  const response = await fetch(url + '/wagering/transactions', {
    ...jsonRequest(command.data),
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as WagerProcessingResult;
}

test('three production containers share HTTP/SQS processing, pending resume and Outbox publishing', async () => {
  const ids = (await db.run(['ps', '--quiet', 'app', 'app2', 'app3'])).trim().split('\n');
  expect(new Set(ids).size).toBe(3);
  const processes = await db.run(['top', 'app', 'app2', 'app3']);
  expect(processes.split('bun dist/main.js').length - 1).toBe(3);
  await Bun.write('/tmp/t27-container-processes.txt', processes);
  await db.run(['exec', '-T', 'app', 'sh', '-c', 'test ! -d /app/test && test ! -d /app/src']);
  const created = await fetch(
    URLS[0] + '/wallets',
    jsonRequest({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100', currency: 'BRL' },
    }),
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const wallet = (await new WalletRepository(db.app.manager).findById(id))!;
  const bet = wagerCommand(wallet);
  const responses = await Promise.all(URLS.map((url) => submit(url, bet)));
  expect(new Set(responses.map((response) => response.transactionId)).size).toBe(1);
  expect(responses.filter((response) => !response.idempotentReplay)).toHaveLength(1);
  await enqueueWager(
    db,
    wagerCommand(wallet, { kind: Kind.Win, money: { amount: '5', currency: 'BRL' } }),
  );
  await waitFor(
    async () =>
      (await new WalletRepository(db.app.manager).findById(id))?.balance.toString() === '80.00',
  );
  const lateBet = wagerCommand(wallet, { money: { amount: '1', currency: 'BRL' } });
  const refund = wagerCommand(wallet, {
    kind: Kind.Refund,
    money: { amount: '1', currency: 'BRL' },
    referenceExternalTransactionId: lateBet.data.externalTransactionId,
  });
  const pending = await fetch(URLS[1] + '/wagering/transactions', {
    ...jsonRequest(refund.data),
    headers: { 'content-type': 'application/json', 'idempotency-key': refund.idempotencyKey },
  });
  expect(pending.status).toBe(202);
  await submit(URLS[2]!, lateBet);
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ status: string }>>(
      'SELECT status FROM wagering.wager_transactions WHERE idempotency_key=$1',
      [refund.idempotencyKey],
    );
    return row?.status === 'PROCESSED';
  });
  await assertWalletLedger(db.app, wallet.id, '80.00');
  for (const url of URLS) {
    const response = await fetch(url + '/wallets/' + wallet.id);
    expect(await response.json()).toMatchObject({
      balance: { amount: '80.00', currency: 'BRL' },
      version: 5,
    });
  }
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ remaining: number }>>(
      'SELECT count(*)::int AS remaining FROM wagering.outbox_messages WHERE published_at IS NULL',
    );
    return row?.remaining === 0;
  });
  expect(
    (await db.sqs.queueDepth(await db.sqs.queueUrl(OUTBOUND_QUEUE_NAME))).visible,
  ).toBeGreaterThan(0);
  const started = Date.now();
  await db.run(['stop', 'app', 'app2', 'app3']);
  expect(Date.now() - started).toBeLessThan(30000);
  const logs = await db.run(['logs', '--no-color', 'app', 'app2', 'app3']);
  expect(logs).not.toContain('worker_shutdown_deadline');
}, 45_000);
