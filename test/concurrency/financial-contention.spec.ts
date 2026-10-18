import { readPendingReferenceConfig } from '@/config/pending-reference';
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
  waitFor,
} from '@test/support/financial.util';
import { withTransaction } from '@/database/transaction';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { createDatabaseDataSource } from '@/database/data-source';
import { isRetryablePostgresError } from '@/shared/utils/postgres.util';
import { FailureCode, WagerTransactionStatus } from '@/shared/enums/wager.enum';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);

test('50 identical simultaneous bets commit one debit and one processed event', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const service = financialServices(db.app).process;
  const results = await Promise.all(
    Array.from({ length: 50 }, () => service.execute(command, TEST_CONTEXT)),
  );
  expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  expect(results.every((r) => r.balance.amount === '75.00')).toBe(true);
  const [counts] = await db.app.query<Array<{ debits: number; events: number }>>(
    `SELECT (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT') AS debits,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=$1 AND event_type='WagerTransactionProcessed') AS events`,
    [wallet.id],
  );
  expect(counts).toEqual({ debits: 1, events: 2 });
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 15_000);

test('two distinct 80.00 bets on 100.00 serialize into one success and one rejection', async () => {
  const wallet = await openTestWallet(db.app);
  const service = financialServices(db.app).process;
  const commands = Array.from({ length: 2 }, () =>
    wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
  );
  const results = await Promise.all(
    commands.map((command) => service.execute(command, TEST_CONTEXT)),
  );
  expect(results.map((r) => r.status).sort()).toEqual(
    [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort(),
  );
  expect(results.find((r) => r.status === WagerTransactionStatus.Rejected)?.failureCode).toBe(
    FailureCode.InsufficientFunds,
  );
  const [counts] = await db.app.query<Array<{ debits: number; version: number }>>(
    `SELECT w.version,count(l.id)::int AS debits FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id AND l.direction='DEBIT' WHERE w.id=$1 GROUP BY w.id`,
    [wallet.id],
  );
  expect(counts).toEqual({ debits: 1, version: 2 });
  await Promise.all(commands.map((command) => service.execute(command, TEST_CONTEXT)));
  await assertWalletLedger(db.app, wallet.id, '20.00');
});

test('a held wallet blocks its own writer while a different wallet completes', async () => {
  const first = await openTestWallet(db.app),
    second = await openTestWallet(db.app);
  const blocker = db.app.createQueryRunner();
  await blocker.startTransaction();
  await blocker.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [first.id]);
  let completed = false;
  const blocked = financialServices(db.app)
    .process.execute(wagerCommand(first), TEST_CONTEXT)
    .then((result) => {
      completed = true;
      return result;
    });
  try {
    await waitFor(async () => {
      const [row] = await db.app.query<Array<{ waiting: boolean }>>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting",
      );
      return row?.waiting === true;
    });
    expect(
      (await financialServices(db.app).process.execute(wagerCommand(second), TEST_CONTEXT)).balance
        .amount,
    ).toBe('75.00');
    expect(completed).toBe(false);
  } finally {
    await blocker.rollbackTransaction();
    await blocker.release();
    await blocked;
  }
  await assertWalletLedger(db.app, first.id, '75.00');
  await assertWalletLedger(db.app, second.id, '75.00');
});

test('lock timeouts retry fresh transactions a bounded number of times without partial effects', async () => {
  const wallet = await openTestWallet(db.app);
  const config = {
    ...financialServices(db.app).config,
    DATABASE_LOCK_TIMEOUT_MS: 50,
    DATABASE_RETRY_BASE_DELAY_MS: 0,
    DATABASE_RETRY_MAX_DELAY_MS: 0,
  };
  const blocker = db.app.createQueryRunner();
  await blocker.startTransaction();
  await blocker.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [wallet.id]);
  const attempts: string[] = [];
  try {
    expect(
      await failureOf(
        withTransaction(db.app, config, async (manager) => {
          const [row] = await manager.query<Array<{ id: string }>>(
            'SELECT txid_current()::text AS id',
          );
          attempts.push(row!.id);
          await manager.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [
            wallet.id,
          ]);
        }),
      ),
    ).toMatchObject({ driverError: { code: '55P03' } });
  } finally {
    await blocker.rollbackTransaction();
    await blocker.release();
  }
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts).size).toBe(3);
  const service = new ProcessWagerTransactionUseCase(
    createFinancialTransaction(db.app, config),
    readPendingReferenceConfig(),
  );
  expect((await service.execute(wagerCommand(wallet), TEST_CONTEXT)).balance.amount).toBe('75.00');
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('PostgreSQL breaks a real deadlock and the aborted callback retries from a fresh transaction', async () => {
  const wallets = [await openTestWallet(db.app), await openTestWallet(db.app)];
  const gate = Promise.withResolvers<void>();
  let arrived = 0;
  const attempts = [0, 0];
  const config = { ...financialServices(db.app).config, DATABASE_LOCK_TIMEOUT_MS: 4000 };
  await Promise.all(
    [0, 1].map((index) =>
      withTransaction(db.app, config, async (manager) => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        await manager.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [
          wallets[index]!.id,
        ]);
        if (attempts[index] === 1) {
          arrived++;
          if (arrived === 2) gate.resolve();
          await gate.promise;
        }
        await manager.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [
          wallets[1 - index]!.id,
        ]);
      }),
    ),
  );
  expect(attempts.sort()).toEqual([1, 2]);
  for (const wallet of wallets) await assertWalletLedger(db.app, wallet.id, '100.00');
}, 10_000);

test('serialization errors retry; uniqueness and connection failures are not guessed safe to retry', async () => {
  const { config } = financialServices(db.app);
  let attempts = 0;
  await withTransaction(db.app, config, async (manager) => {
    attempts++;
    if (attempts === 1)
      await manager.query(
        "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='injected serialization failure'; END $$",
      );
  });
  expect(attempts).toBe(2);
  expect(isRetryablePostgresError({ code: '23505' })).toBe(false);
  expect(isRetryablePostgresError({ code: '08006' })).toBe(false);
  let disconnectAttempts = 0;
  expect(
    await failureOf(
      withTransaction(db.app, config, async (manager) => {
        disconnectAttempts++;
        await manager.query('SELECT pg_terminate_backend(pg_backend_pid())');
      }),
    ),
  ).toBeInstanceOf(Error);
  expect(disconnectAttempts).toBe(1);
});

test('lost response after commit is resolved by durable replay through a new connection pool', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const { config } = financialServices(db.app);
  const disconnected = createDatabaseDataSource(config, db.app.options.entities);
  await disconnected.initialize();
  const original = await new ProcessWagerTransactionUseCase(
    createFinancialTransaction(disconnected, config),
    readPendingReferenceConfig(),
  ).execute(command, TEST_CONTEXT);
  await disconnected.destroy();
  expect(await financialServices(db.app).process.execute(command, TEST_CONTEXT)).toEqual({
    ...original,
    idempotentReplay: true,
  });
  await assertWalletLedger(db.app, wallet.id, '75.00');
});
