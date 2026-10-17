import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { readDatabaseConfig } from '@/config/database';
import { Money } from '@/shared/domain/money.domain';

let db: Awaited<ReturnType<typeof startPostgresTest>>, useCase: OpenWalletUseCase;
beforeAll(async () => {
  db = await startPostgresTest();
  useCase = new OpenWalletUseCase(
    db.app,
    readDatabaseConfig({
      DATABASE_URL: db.app.options.type === 'postgres' ? db.app.options.url! : '',
    }),
  );
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const CONTEXT = { correlationId: 'opening-test' };
async function verify(id: string, balance: string, entries: number) {
  const [row] = await db.app.query<
    Array<{
      balance: string;
      version: number;
      count: number;
      consistent: boolean;
    }>
  >(
    "SELECT w.balance,w.version,count(l.id)::integer AS count,w.balance=coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0) AS consistent FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id",
    [id],
  );
  expect(row).toEqual({
    balance,
    version: 1,
    count: entries,
    consistent: true,
  });
}

test('positive opening atomically stores wallet, OPENING, credit ledger and both events', async () => {
  const wallet = await useCase.execute(
    { playerId: crypto.randomUUID(), initialBalance: brl('100.01') },
    CONTEXT,
  );
  await verify(wallet.id, '100.01', 1);
  const rows = await db.app.query<
    Array<{
      kind: string;
      status: string;
      result_balance: string;
    }>
  >('SELECT kind,status,result_balance FROM wagering.wager_transactions WHERE wallet_id=$1', [
    wallet.id,
  ]);
  expect(rows).toEqual([
    {
      kind: 'OPENING',
      status: 'PROCESSED',
      result_balance: '100.01',
    },
  ]);
  const events = await db.app.query<Array<{ event_type: string }>>(
    'SELECT event_type FROM wagering.outbox_messages WHERE aggregate_id=$1 ORDER BY event_type',
    [wallet.id],
  );
  expect(events).toEqual([
    { event_type: 'WagerTransactionProcessed' },
    { event_type: 'WalletBalanceChanged' },
  ]);
});

test('zero opening has no financial records or events; negative and unsupported currency fail', async () => {
  const wallet = await useCase.execute(
    { playerId: crypto.randomUUID(), initialBalance: brl('0') },
    CONTEXT,
  );
  await verify(wallet.id, '0.00', 0);
  expect(
    await db.app.query('SELECT id FROM wagering.wager_transactions WHERE wallet_id=$1', [
      wallet.id,
    ]),
  ).toHaveLength(0);
  expect(
    await db.app.query('SELECT id FROM wagering.outbox_messages WHERE aggregate_id=$1', [
      wallet.id,
    ]),
  ).toHaveLength(0);
  for (const initialBalance of [brl('1').negate(), Money.from({ amount: '1', currency: 'USD' })]) {
    let error: unknown;
    try {
      await useCase.execute({ playerId: crypto.randomUUID(), initialBalance }, CONTEXT);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
  }
});

test('simultaneous duplicate opening has one winner and one explicit conflict', async () => {
  const input = { playerId: crypto.randomUUID(), initialBalance: brl('20') };
  const results = await Promise.allSettled([
    useCase.execute(input, CONTEXT),
    useCase.execute(input, CONTEXT),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of results) {
    if (r.status === 'fulfilled') await verify(r.value.id, '20.00', 1);
    else expect(r.reason).toHaveProperty('code', 'WALLET_CONFLICT');
  }
});

test('database failures after each write roll back the entire opening', async () => {
  await db.owner.query(
    "CREATE FUNCTION wagering.test_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected opening failure'; END $$",
  );
  try {
    for (const table of [
      'wallets',
      'wager_transactions',
      'wallet_ledger_entries',
      'outbox_messages',
    ]) {
      const before = await db.owner.query<unknown[]>(
        `SELECT (SELECT count(*) FROM wagering.wallets) AS wallets,(SELECT count(*) FROM wagering.wager_transactions) AS wagers,(SELECT count(*) FROM wagering.wallet_ledger_entries) AS ledger,(SELECT count(*) FROM wagering.outbox_messages) AS events`,
      );
      await db.owner.query(
        `CREATE TRIGGER test_fault AFTER INSERT ON wagering.${table} FOR EACH ROW EXECUTE FUNCTION wagering.test_reject_insert()`,
      );
      try {
        let error: unknown;
        try {
          await useCase.execute(
            { playerId: crypto.randomUUID(), initialBalance: brl('10') },
            CONTEXT,
          );
        } catch (e) {
          error = e;
        }
        expect(error).toHaveProperty(
          'message',
          expect.stringContaining('injected opening failure'),
        );
      } finally {
        await db.owner.query(`DROP TRIGGER test_fault ON wagering.${table}`);
      }
      expect(
        await db.owner.query(
          `SELECT (SELECT count(*) FROM wagering.wallets) AS wallets,(SELECT count(*) FROM wagering.wager_transactions) AS wagers,(SELECT count(*) FROM wagering.wallet_ledger_entries) AS ledger,(SELECT count(*) FROM wagering.outbox_messages) AS events`,
        ),
      ).toEqual(before);
    }
  } finally {
    await db.owner.query('DROP FUNCTION wagering.test_reject_insert()');
  }
});
