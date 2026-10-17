import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest, enqueueWager } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  openTestWallet,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { startRecoveryWorkers } from '@test/support/recovery-workers.util';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '@/shared/enums/wager.enum';
import { DEAD_LETTER_QUEUE_NAME } from '@/shared/consts/messaging.constant';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
}, 180000);
afterAll(async () => {
  await db?.close();
}, 30000);
async function outcome(key: string, status: Status) {
  await waitFor(async () => {
    const [row] = await db.app.query<Array<{ status: string }>>(
      'SELECT status FROM wagering.wager_transactions WHERE idempotency_key=$1',
      [key],
    );
    return row?.status === status;
  }, 10000);
}
async function verify(
  walletId: string,
  balance: string,
  version: number,
  events: number
) {
  await assertWalletLedger(db.app, walletId, balance);
  const [row] = await db.app.query<
    Array<{
      version: number;
      ledger: number;
      events: number;
      pending: number;
      failed: number;
    }>
  >(
    `SELECT w.version,
    (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=w.id) AS events,
    (SELECT count(*)::int FROM wagering.pending_reference_work p JOIN wagering.wager_transactions t ON t.id=p.transaction_id WHERE t.wallet_id=w.id) AS pending,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=w.id AND status='FAILED') AS failed
    FROM wagering.wallets w WHERE w.id=$1`,
    [walletId],
  );
  expect(row).toEqual({
    version,
    ledger: version,
    events,
    pending: 0,
    failed: 0,
  });
}
for (const kind of [Kind.Refund, Kind.Rollback] as const) {
  test(`${kind} before BET survives worker replacement and three resolvers apply it once`, async () => {
    const wallet = await openTestWallet(db.app);
    const bet = wagerCommand(wallet);
    const reversal = wagerCommand(wallet, {
      kind,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await enqueueWager(db, reversal);
    const first = await startRecoveryWorkers(db);
    try {
      await outcome(reversal.idempotencyKey, Status.PendingReference);
      await assertWalletLedger(db.app, wallet.id, '100.00');
    } finally {
      await first.kill();
    }
    const [persisted] = await db.app.query<Array<{ expires_at: Date; attempts: number }>>(
      'SELECT p.expires_at,p.attempts FROM wagering.pending_reference_work p JOIN wagering.wager_transactions t ON t.id=p.transaction_id WHERE t.idempotency_key=$1',
      [reversal.idempotencyKey],
    );
    expect(persisted).toBeDefined();
    await enqueueWager(db, bet);
    const replacement = await startRecoveryWorkers(db);
    try {
      await outcome(bet.idempotencyKey, Status.Processed);
      await outcome(reversal.idempotencyKey, Status.Processed);
      await verify(
        wallet.id,
        '100.00',
        3,
        7
      );
      expect(
        await db.app.query<Array<{ count: number }>>(
          "SELECT count(*)::int AS count FROM wagering.wager_transactions WHERE wallet_id=$1 AND kind=$2 AND status='PROCESSED'",
          [wallet.id, kind],
        ),
      ).toEqual([{ count: 1 }]);
    } finally {
      await replacement.stop();
    }
  }, 20000);
}

test('persisted expiry survives restart and three resolvers emit one terminal rejection', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet, {
    kind: Kind.Refund,
    referenceExternalTransactionId: crypto.randomUUID(),
  });
  await enqueueWager(db, command);
  const first = await startRecoveryWorkers(db);
  try {
    await outcome(command.idempotencyKey, Status.PendingReference);
  } finally {
    await first.kill();
  }
  // Advance the persisted deadline instead of sleeping the five-minute demo TTL.
  await db.owner.query(
    "UPDATE wagering.pending_reference_work SET expires_at=clock_timestamp()-interval '1 second' WHERE transaction_id=(SELECT id FROM wagering.wager_transactions WHERE idempotency_key=$1)",
    [command.idempotencyKey],
  );
  const replacement = await startRecoveryWorkers(db);
  try {
    await outcome(command.idempotencyKey, Status.Rejected);
    expect(
      await db.app.query<Array<{ failure_code: string }>>(
        'SELECT failure_code FROM wagering.wager_transactions WHERE idempotency_key=$1',
        [command.idempotencyKey],
      ),
    ).toEqual([{ failure_code: FailureCode.ReferenceNotFoundExpired }]);
    await verify(
      wallet.id,
      '100.00',
      1,
      4
    );
    expect(
      await db.app.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionRejected'",
        [wallet.id],
      ),
    ).toEqual([{ count: 1 }]);
  } finally {
    await replacement.stop();
  }
}, 20000);

test('real worker retries send poison to FIFO DLQ while business rejection is acknowledged', async () => {
  const wallet = await openTestWallet(db.app);
  const rejected = wagerCommand(wallet, { money: { amount: '999.00', currency: 'BRL' } });
  const poison = 'invalid-json-from-provider';
  await enqueueWager(db, rejected);
  await db.sqs.send(
    db.queueUrl,
    poison,
    crypto.randomUUID(),
    crypto.randomUUID()
  );
  const dlq = await db.sqs.queueUrl(DEAD_LETTER_QUEUE_NAME);
  const workers = await startRecoveryWorkers(db);
  try {
    await outcome(rejected.idempotencyKey, Status.Rejected);
    await waitFor(async () => (await db.sqs.queueDepth(dlq)).visible === 1, 10000);
    await waitFor(async () => {
      const depth = await db.sqs.queueDepth(db.queueUrl);
      return depth.visible === 0 && depth.inFlight === 0;
    });
    const [dead] = await db.sqs.receive(dlq);
    expect(dead?.Body).toBe(poison);
    await db.sqs.delete(dlq, dead!.ReceiptHandle!);
    await verify(
      wallet.id,
      '100.00',
      1,
      3
    );
  } finally {
    await workers.stop();
  }
}, 20000);
