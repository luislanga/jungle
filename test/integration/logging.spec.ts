import {
  createPendingWorkStore,
  createOutboxStore,
} from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
} from '@test/support/financial.util';
import { SqsWagerConsumer } from '@/modules/messaging/application/sqs-wager.consumer';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';
import { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';
import type { LogContext } from '@/shared/interfaces/logging.interface';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';

let db: Awaited<ReturnType<typeof startMessagingTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
  http = await startHttpTest(db.app);
}, 180_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

test('JSON logs trace HTTP/SQS/replay/resume/publish outcomes without bodies, amounts or credentials', async () => {
  const lines: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  let walletId: string;
  try {
    const wallet = await openTestWallet(db.app);
    walletId = wallet.id;
    const command = wagerCommand(wallet);
    const init = {
      ...jsonRequest(command.data),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': command.idempotencyKey,
        'x-correlation-id': 'trace-log-test',
        authorization: 'Bearer DO_NOT_LOG_AUTHORIZATION',
      },
    };
    expect((await http.request('/wagering/transactions', init)).status).toBe(200);
    expect((await http.request('/wagering/transactions', init)).status).toBe(200);
    expect(
      (
        await http.request('/wallets/invalid', {
          headers: { 'x-correlation-id': 'trace-log-test' },
        })
      ).status,
    ).toBe(400);
    const consumer = new SqsWagerConsumer(db.sqs, financialServices(db.app).process, db.config);
    await enqueueWager(
      db,
      wagerCommand(wallet, { kind: Kind.Win, money: { amount: '5', currency: 'BRL' } }),
    );
    expect((await consumer.pollOnce()).acknowledged).toBe(1);
    const bet = wagerCommand(wallet, { money: { amount: '1', currency: 'BRL' } });
    const pending = await financialServices(db.app).process.execute(
      wagerCommand(wallet, {
        kind: Kind.Refund,
        money: { amount: '1', currency: 'BRL' },
        referenceExternalTransactionId: bet.data.externalTransactionId,
      }),
      TEST_CONTEXT,
    );
    await financialServices(db.app).process.execute(bet, TEST_CONTEXT);
    await db.owner.query(
      'UPDATE wagering.pending_reference_work SET next_attempt_at=now() WHERE transaction_id=$1',
      [pending.transactionId],
    );
    await new PendingReferenceResolver(
      createPendingWorkStore(db.app, financialServices(db.app).config),
      financialServices(db.app).process,
    ).runOnce();
    await new OutboxPublisher(
      createOutboxStore(db.app, financialServices(db.app).config),
      db.sqs,
    ).runOnce();
    writeLog('redaction_probe', {
      correlationId: 'trace-log-test',
      password: 'DO_NOT_LOG_PASSWORD',
      payload: command.data,
      authorization: 'DO_NOT_LOG_AUTHORIZATION',
      amount: 'DO_NOT_LOG_MONEY',
    } as unknown as LogContext);
    await assertWalletLedger(db.app, wallet.id, '80.00');
  } finally {
    output.mockRestore();
  }
  const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const event of [
    'wallet_opened',
    'http_request_completed',
    'http_request_failed',
    'wager_outcome',
    'wager_replayed',
    'sqs_acknowledged',
    'wager_reference_resumed',
    'outbox_published',
  ])
    expect(logs.some((log) => log.event === event)).toBe(true);
  expect(
    logs.some(
      (log) =>
        log.event === 'wager_outcome' &&
        log.correlationId === 'trace-log-test' &&
        log.walletId === walletId &&
        typeof log.transactionId === 'string' &&
        log.providerId === 'provider-test',
    ),
  ).toBe(true);
  expect(
    logs.some(
      (log) =>
        log.event === 'sqs_acknowledged' &&
        typeof log.messageId === 'string' &&
        typeof log.sqsMessageId === 'string' &&
        log.messageId !== log.sqsMessageId,
    ),
  ).toBe(true);
  expect(
    logs.some((log) => log.event === 'outbox_published' && log.correlationId === 'trace-log-test'),
  ).toBe(true);
  expect(
    logs.some(
      (log) =>
        log.event === 'http_request_failed' &&
        log.failureCode === 'INVALID_REQUEST' &&
        log.errorType === 'ZodError',
    ),
  ).toBe(true);
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain('DO_NOT_LOG');
  expect(serialized).not.toContain('"amount":');
  expect(serialized).not.toContain('postgresql://');
  expect(
    logs.every((log) => typeof log.timestamp === 'string' && typeof log.level === 'string'),
  ).toBe(true);
});
