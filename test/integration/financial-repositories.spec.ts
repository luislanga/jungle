import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { Wallet } from '@/modules/wallet/domain/wallet.domain';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry.domain';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';
import { WalletLedgerEntryRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet-ledger-entry.repository';
import { WagerTransactionRepository } from '@/modules/wagering/infrastructure/persistence/repositories/wager-transaction.repository';
import { WagerTransactionMapper } from '@/modules/wagering/infrastructure/persistence/mappers/wager-transaction.mapper';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '@/shared/enums/wager.enum';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { Money } from '@/shared/domain/money.domain';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const PAYLOAD_HASH = 'a'.repeat(64);
const brl = (amount = '0') => Money.from({ amount, currency: 'BRL' });
const wallet = () =>
  Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl(),
  });
function props(w: Wallet, kind = Kind.Loss) {
  const id = crypto.randomUUID();
  return {
    id,
    providerId: 'provider',
    externalTransactionId: id,
    idempotencyKey: id,
    payloadHash: PAYLOAD_HASH,
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'r',
    gameId: 'g',
    kind,
    money: brl(),
  };
}

test('mappers preserve every persisted status, nullable fields and original balances without replaying transitions', async () => {
  const w = wallet();
  await db.app.transaction((m) => new WalletRepository(m).insert(w));
  for (const status of Object.values(Status)) {
    const transaction = WagerTransaction.rehydrate({
      ...props(w, status === Status.PendingReference ? Kind.Refund : Kind.Loss),
      money: brl(status === Status.PendingReference ? '1' : '0'),
      status,
      createdAt: new Date(),
      ...(status === Status.PendingReference ? { referenceExternalTransactionId: 'missing' } : {}),
      ...(status === Status.Processed ? { processedAt: new Date() } : {}),
      ...([Status.Rejected, Status.Failed].includes(status)
        ? { failureCode: FailureCode.PermanentProcessingFailure }
        : {}),
    });
    await db.app.transaction((m) => new WagerTransactionRepository(m).insert(transaction, brl()));
    const stored = await new WagerTransactionRepository(db.app.manager).findByKey(
      transaction.idempotencyKey,
    );
    expect(stored?.transaction.status).toBe(status);
    expect(stored?.transaction.failureCode).toBe(transaction.failureCode);
    expect(stored?.transaction.referenceExternalTransactionId).toBe(
      transaction.referenceExternalTransactionId,
    );
    expect(stored?.resultBalance?.toString()).toBe('0.00');
    expect(
      (
        await new WagerTransactionRepository(db.app.manager).findByExternalId(
          transaction.providerId,
          transaction.externalTransactionId,
        )
      )?.transaction.id,
    ).toBe(transaction.id);
    const row = WagerTransactionMapper.toPersistence(transaction, brl());
    expect(
      WagerTransactionMapper.toPersistence(WagerTransactionMapper.toDomain(row), brl()),
    ).toEqual(row);
  }
  const [sum] = await db.app.query<Array<{ balance: string; total: string }>>(
    "SELECT balance,(SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::text FROM wagering.wallet_ledger_entries WHERE wallet_id=$1) AS total FROM wagering.wallets WHERE id=$1",
    [w.id],
  );
  expect(sum).toEqual({ balance: '0.00', total: '0' });
});

test('exact large amounts round-trip through wallet, opening wager and immutable ledger in one transaction', async () => {
  const money = brl('9007199254740993.01');
  const w = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: money,
  });
  const transaction = WagerTransaction.opening({ ...props(w), money });
  transaction.markProcessed(undefined, new Date());
  const entry = WalletLedgerEntry.create({
    id: crypto.randomUUID(),
    walletId: w.id,
    transactionId: transaction.id,
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: brl(),
    balanceAfter: money,
    createdAt: new Date(),
  });
  await db.app.transaction(async (m) => {
    await new WalletRepository(m).insert(w);
    await new WagerTransactionRepository(m).insert(transaction, money);
    await new WalletLedgerEntryRepository(m).insert(entry);
  });
  const loaded = await new WalletRepository(db.app.manager).findById(w.id);
  const audit = await new WalletLedgerEntryRepository(db.app.manager).findByTransaction(
    transaction.id,
  );
  expect(loaded?.balance.toString()).toBe(money.toString());
  expect(audit?.money.toString()).toBe(money.toString());
  expect(audit?.isBalanced()).toBe(true);
  const [sum] = await db.app.query<Array<{ consistent: boolean }>>(
    'SELECT balance=(SELECT sum(amount) FROM wagering.wallet_ledger_entries WHERE wallet_id=$1) AS consistent FROM wagering.wallets WHERE id=$1',
    [w.id],
  );
  expect(sum?.consistent).toBe(true);
});

test('caller transaction controls rollback and financial repositories reject autocommit writes', async () => {
  const w = wallet();
  let caught = false;
  try {
    await db.app.transaction(async (m) => {
      await new WalletRepository(m).insert(w);
      throw new Error('rollback');
    });
  } catch {
    caught = true;
  }
  expect(caught).toBe(true);
  expect(await new WalletRepository(db.app.manager).findById(w.id)).toBeNull();
  try {
    await new WalletRepository(db.app.manager).insert(w);
    throw new Error('should reject');
  } catch (error) {
    expect((error as Error).message).toContain('active transaction');
  }
});

test('wallet locks serialize the same wallet while a different wallet progresses', async () => {
  const a = wallet(),
    b = wallet();
  await db.app.transaction(async (m) => {
    await new WalletRepository(m).insert(a);
    await new WalletRepository(m).insert(b);
  });
  const holder = db.app.createQueryRunner();
  await holder.connect();
  await holder.startTransaction();
  const waiter = db.app.createQueryRunner();
  await waiter.connect();
  await waiter.startTransaction();
  const [backend] = await waiter.manager.query<Array<{ pid: number }>>(
    'SELECT pg_backend_pid() AS pid',
  );
  let waiting: Promise<Wallet | null> | undefined;
  try {
    await new WalletRepository(holder.manager).findById(a.id, true);
    waiting = new WalletRepository(waiter.manager).findById(a.id, true);
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await db.owner.query<Array<{ blocked: boolean }>>(
        'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS blocked',
        [backend!.pid],
      );
      if (rows[0]?.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    expect(
      (await db.app.transaction((m) => new WalletRepository(m).findById(b.id, true)))?.id,
    ).toBe(b.id);
  } finally {
    await holder.rollbackTransaction();
    await holder.release();
    await waiting;
    await waiter.rollbackTransaction();
    await waiter.release();
  }
});
