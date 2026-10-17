import { createPendingWorkStore } from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { createFinancialTransaction } from '@/database/financial-transaction.factory';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import {
  assertWalletLedger,
  failureOf,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
} from '@test/support/financial.util';
import { PendingReferenceResolver } from '@/modules/messaging/application/pending-reference.resolver';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { readPendingReferenceConfig } from '@/config/pending-reference';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const resolver = (batch = 20) =>
  new PendingReferenceResolver(
    createPendingWorkStore(db.app, financialServices(db.app).config),
    financialServices(db.app).process,
    { ...readPendingReferenceConfig({}), PENDING_REFERENCE_BATCH_SIZE: batch },
  );
const due = (id: string) =>
  db.owner.query(
    'UPDATE wagering.pending_reference_work SET next_attempt_at=clock_timestamp() WHERE transaction_id=$1',
    [id],
  );

async function status(id: string) {
  const [row] = await db.app.query<Array<{ status: Status; failure_code: FailureCode | null }>>(
    'SELECT status,failure_code FROM wagering.wager_transactions WHERE id=$1',
    [id],
  );
  return row!;
}

test('REFUND, ROLLBACK and optional referenced WIN resolve after a late BET, without new wager identities', async () => {
  for (const kind of [Kind.Refund, Kind.Rollback, Kind.Win] as const) {
    const wallet = await openTestWallet(db.app),
      bet = wagerCommand(wallet),
      service = financialServices(db.app).process;
    const pending = await service.execute(
      wagerCommand(wallet, {
        kind,
        referenceExternalTransactionId: bet.data.externalTransactionId,
      }),
      TEST_CONTEXT,
    );
    expect(pending.status).toBe(Status.PendingReference);
    await due(pending.transactionId);
    expect((await resolver().runOnce()).deferred).toBe(1);
    await service.execute(bet, TEST_CONTEXT);
    await due(pending.transactionId);
    expect((await resolver().runOnce()).completed).toBe(1);
    expect((await status(pending.transactionId)).status).toBe(Status.Processed);
    const [counts] = await db.app.query<Array<{ wagers: number; pending_events: number }>>(
      `SELECT (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=$1) AS wagers,
      (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionPendingReference') AS pending_events`,
      [wallet.id],
    );
    expect(counts).toEqual({ wagers: 3, pending_events: 1 });
    await assertWalletLedger(db.app, wallet.id, '100.00');
  }
});

test('ten-attempt exhaustion rejects before the five-minute TTL, emitting one terminal event', async () => {
  const wallet = await openTestWallet(db.app),
    command = wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: 'never-arrives',
    });
  const pending = await financialServices(db.app).process.execute(command, TEST_CONTEXT);
  for (let attempt = 1; attempt <= 10; attempt++) {
    await due(pending.transactionId);
    const result = await resolver().runOnce();
    expect(result.completed).toBe(attempt === 10 ? 1 : 0);
  }
  expect(await status(pending.transactionId)).toEqual({
    status: Status.Rejected,
    failure_code: FailureCode.ReferenceNotFoundExpired,
  });
  expect(
    (await financialServices(db.app).process.execute(command, TEST_CONTEXT)).idempotentReplay,
  ).toBe(true);
  const [row] = await db.app.query<Array<{ count: number }>>(
    "SELECT count(*)::int AS count FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionRejected'",
    [wallet.id],
  );
  expect(row?.count).toBe(1);
  expect((await resolver().runOnce()).claimed).toBe(0);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('a five-minute TTL expiry is claimed even before the next scheduled evaluation or attempt cap', async () => {
  const wallet = await openTestWallet(db.app);
  const pending = await financialServices(db.app).process.execute(
    wagerCommand(wallet, { kind: Kind.Rollback, referenceExternalTransactionId: 'never-arrives' }),
    TEST_CONTEXT,
  );
  // Advance persisted scheduling time, not production policy: no five-minute test sleep.
  await db.owner.query(
    "UPDATE wagering.pending_reference_work SET attempts=0,expires_at=clock_timestamp()-interval '1 millisecond',next_attempt_at=clock_timestamp()+interval '1 hour' WHERE transaction_id=$1",
    [pending.transactionId],
  );
  expect((await resolver().runOnce()).completed).toBe(1);
  expect((await status(pending.transactionId)).failure_code).toBe(
    FailureCode.ReferenceNotFoundExpired,
  );
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('two resolvers process disjoint batches and a replaced expired token cannot resume work', async () => {
  const wallets = [];
  for (let index = 0; index < 4; index++) {
    const wallet = await openTestWallet(db.app),
      bet = wagerCommand(wallet);
    const pending = await financialServices(db.app).process.execute(
      wagerCommand(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.data.externalTransactionId,
      }),
      TEST_CONTEXT,
    );
    await financialServices(db.app).process.execute(bet, TEST_CONTEXT);
    await due(pending.transactionId);
    wallets.push(wallet);
  }
  const batches = await Promise.all([resolver(2).runOnce(), resolver(2).runOnce()]);
  expect(batches.map((batch) => batch.completed).sort()).toEqual([2, 2]);
  for (const wallet of wallets) await assertWalletLedger(db.app, wallet.id, '100.00');
  const wallet = await openTestWallet(db.app),
    bet = wagerCommand(wallet);
  const pending = await financialServices(db.app).process.execute(
    wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
    TEST_CONTEXT,
  );
  await due(pending.transactionId);
  const [old] = await db.app.transaction((manager) =>
    new PendingReferenceWorkRepository(manager).claimDue({
      owner: 'old-instance',
      limit: 1,
      leaseMs: 30000,
    }),
  );
  await db.owner.query(
    "UPDATE wagering.pending_reference_work SET claim_until=clock_timestamp()-interval '1 millisecond' WHERE transaction_id=$1",
    [pending.transactionId],
  );
  expect((await resolver().runOnce()).deferred).toBe(1);
  expect(
    await failureOf(
      financialServices(db.app).process.resume(old!.transactionId, old!.token, TEST_CONTEXT),
    ),
  ).toHaveProperty('code', 'STALE_CLAIM');
  await financialServices(db.app).process.execute(bet, TEST_CONTEXT);
  await due(pending.transactionId);
  expect((await resolver().runOnce()).completed).toBe(1);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('late invalid context and terminal rejected references become audited rejections', async () => {
  for (const invalidContext of [true, false]) {
    const wallet = await openTestWallet(db.app),
      service = financialServices(db.app).process;
    const bet = wagerCommand(
      wallet,
      invalidContext ? { roundId: 'another-round' } : { money: { amount: '500', currency: 'BRL' } },
    );
    const pending = await service.execute(
      wagerCommand(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.data.externalTransactionId,
      }),
      TEST_CONTEXT,
    );
    await service.execute(bet, TEST_CONTEXT);
    await due(pending.transactionId);
    expect((await resolver().runOnce()).completed).toBe(1);
    expect((await status(pending.transactionId)).failure_code).toBe(
      invalidContext ? FailureCode.ReferenceContextMismatch : FailureCode.ReferenceNotProcessed,
    );
    await assertWalletLedger(db.app, wallet.id, invalidContext ? '75.00' : '100.00');
  }
});

test('configured attempt overrides survive reconstruction of a resolver instance', async () => {
  const wallet = await openTestWallet(db.app),
    database = financialServices(db.app).config;
  const config = readPendingReferenceConfig({
    PENDING_REFERENCE_MAX_ATTEMPTS: '2',
    PENDING_REFERENCE_TTL_MS: '3600000',
    PENDING_REFERENCE_RETRY_BASE_MS: '1',
    PENDING_REFERENCE_RETRY_MAX_MS: '1',
  });
  const service = new ProcessWagerTransactionUseCase(
    createFinancialTransaction(db.app, database),
    config,
  );
  const pending = await service.execute(
    wagerCommand(wallet, { kind: Kind.Refund, referenceExternalTransactionId: 'missing' }),
    TEST_CONTEXT,
  );
  await due(pending.transactionId);
  expect(
    (
      await new PendingReferenceResolver(
        createPendingWorkStore(db.app, database),
        service,
        config,
      ).runOnce()
    ).deferred,
  ).toBe(1);
  await due(pending.transactionId);
  expect(
    (
      await new PendingReferenceResolver(
        createPendingWorkStore(db.app, database),
        service,
        config,
      ).runOnce()
    ).completed,
  ).toBe(1);
  expect((await status(pending.transactionId)).status).toBe(Status.Rejected);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});
