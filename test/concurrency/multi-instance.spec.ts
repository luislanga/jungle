import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import {
  startFinancialRace,
  type FinancialProcessInput,
  type FinancialProcessResult,
} from '@test/support/financial-process.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120000);
afterAll(async () => {
  await db?.close();
}, 30000);
const databaseUrl = () => financialServices(db.app).config.DATABASE_URL;
function successful(results: FinancialProcessResult[]) {
  return results.map((result) => {
    if (!result.ok) throw new Error('Unexpected race failure: ' + result.code);
    return result.value;
  });
}
async function verify(
  walletId: string,
  balance: string,
  version: number,
  events = version * 2
) {
  await assertWalletLedger(db.app, walletId, balance);
  expect(
    await db.app.query<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM wagering.outbox_messages WHERE aggregate_id=$1',
      [walletId],
    ),
  ).toEqual([{ count: events }]);
  expect(
    await db.app.query<Array<{ version: number; entries: number }>>(
      `SELECT w.version,count(l.id)::int AS entries FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
      [walletId],
    ),
  ).toEqual([{ version, entries: version }]);
}
async function run(batches: FinancialProcessInput[][]) {
  const race = await startFinancialRace(databaseUrl(), batches);
  try {
    expect(new Set(race.actors.map((actor) => actor.child.pid)).size).toBe(3);
    expect(new Set(race.actors.map((actor) => actor.backendPid)).size).toBe(3);
    return await race.finish();
  } finally {
    await race.close();
  }
}

test('50 simultaneous identical bets across three Nest processes produce one debit and original response', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const batches = [17, 17, 16].map((count, actor) =>
    Array.from({ length: count }, (_, index) => ({
      command,
      ...(actor === 1
        ? { inbox: { consumerName: 'cross-channel-test', messageId: `duplicate-${index}` } }
        : {}),
    })),
  );
  const results = successful(await run(batches));
  expect(results).toHaveLength(50);
  expect(
    await db.app.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM wagering.inbox_messages WHERE consumer_name='cross-channel-test' AND processed_at IS NOT NULL",
    ),
  ).toEqual([{ count: 17 }]);
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
  expect(results.every((r) => r.balance.amount === '75.00' && r.status === Status.Processed)).toBe(
    true,
  );
  expect(
    await db.app.query<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM wagering.outbox_messages WHERE aggregate_id=$1',
      [wallet.id],
    ),
  ).toEqual([{ count: 4 }]);
  await verify(wallet.id, '75.00', 2);
}, 30000);

test('100/80/80 remains correct while a third process records LOSS', async () => {
  const wallet = await openTestWallet(db.app);
  const commands = [
    wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
    wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }),
    wagerCommand(wallet, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }),
  ];
  const results = successful(await run(commands.map((command) => [{ command }])));
  expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(2);
  expect(results.filter((r) => r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(1);
  await verify(
    wallet.id,
    '20.00',
    2,
    6
  );
}, 30000);

test('two independent wallets finish while another process waits on the hot wallet lock', async () => {
  const wallets = await Promise.all([
    openTestWallet(db.app),
    openTestWallet(db.app),
    openTestWallet(db.app),
  ]);
  const lock = db.app.createQueryRunner();
  await lock.connect();
  await lock.startTransaction();
  await lock.query('SELECT id FROM wagering.wallets WHERE id=$1 FOR NO KEY UPDATE', [
    wallets[0].id,
  ]);
  let race: Awaited<ReturnType<typeof startFinancialRace>> | undefined;
  try {
    race = await startFinancialRace(
      databaseUrl(),
      wallets.map((w) => [{ command: wagerCommand(w) }]),
    );
    const actors = race.actors;
    await waitFor(
      () => actors[1]!.results !== undefined && actors[2]!.results !== undefined,
      10000,
    );
    await waitFor(async () => {
      const [row] = await db.app.query<Array<{ blocked: boolean }>>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%wallets%') AS blocked",
      );
      return row?.blocked === true;
    });
    expect(actors[0]!.results).toBeUndefined();
    for (const wallet of wallets.slice(1)) await verify(wallet.id, '75.00', 2);
    await lock.commitTransaction();
    expect(successful(await race.finish())).toHaveLength(3);
    await verify(wallets[0].id, '75.00', 2);
  } finally {
    if (lock.isTransactionActive) await lock.rollbackTransaction();
    await lock.release();
    await race?.close();
  }
}, 30000);

for (const kind of [Kind.Refund, Kind.Rollback] as const) {
  test(`${kind} same-kind reversal race across three processes applies once`, async () => {
    const wallet = await openTestWallet(db.app);
    const bet = wagerCommand(wallet);
    await financialServices(db.app).process.execute(bet, TEST_CONTEXT);
    const commands = Array.from({ length: 3 }, () =>
      wagerCommand(wallet, {
        kind,
        referenceExternalTransactionId: bet.data.externalTransactionId,
      }),
    );
    const results = successful(await run(commands.map((command) => [{ command }])));
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(
      results.filter((r) => r.failureCode === FailureCode.ReferenceAlreadyReversed),
    ).toHaveLength(2);
    await verify(
      wallet.id,
      '100.00',
      3,
      8
    );
  }, 30000);
}

test('divergent keys and provider identities conflict across processes without extra effects', async () => {
  for (const identity of ['key', 'external'] as const) {
    const wallet = await openTestWallet(db.app);
    const first = wagerCommand(wallet);
    const second = wagerCommand(wallet, {
      ...(identity === 'external'
        ? { externalTransactionId: first.data.externalTransactionId }
        : {}),
      gameId: 'other-game',
    });
    if (identity === 'key') second.idempotencyKey = first.idempotencyKey;
    const results = await run([[{ command: first }], [{ command: second }], [{ command: first }]]);
    const conflicts = results.filter((r) => !r.ok);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(
      conflicts.every(
        (r) =>
          !r.ok &&
          r.code ===
            (identity === 'key' ? 'IDEMPOTENCY_CONFLICT' : 'EXTERNAL_TRANSACTION_CONFLICT'),
      ),
    ).toBe(true);
    expect(results.filter((r) => r.ok && !r.value.idempotentReplay)).toHaveLength(1);
    await verify(wallet.id, '75.00', 2);
  }
}, 30000);
