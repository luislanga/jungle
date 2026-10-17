import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DataSource } from 'typeorm';
import { readDatabaseConfig } from '@/config/database';
import { createDatabaseDataSource } from '@/database/data-source';
import { WalletEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '@/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { Money } from '@/shared/domain/money.domain';
import { compose } from '@test/support/compose';

const project = `wagering-schema-${crypto.randomUUID()}`;
const env = {
  POSTGRES_PORT: '0',
  POSTGRES_PASSWORD: crypto.randomUUID(),
  APP_DATABASE_PASSWORD: crypto.randomUUID(),
  MIGRATION_DATABASE_PASSWORD: crypto.randomUUID(),
};
let app: DataSource;
let owner: DataSource;
async function run(args: string[]) {
  const result = await compose(project, env, args);
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout;
}
beforeAll(async () => {
  await run(['up', '--detach', '--wait', 'postgres']);
  await run(['build', 'migrations']);
  await run(['run', '--rm', 'migrations', 'update']);
  const port = (await run(['port', 'postgres', '5432'])).trim().split(':').at(-1);
  app = createDatabaseDataSource(
    readDatabaseConfig({
      DATABASE_URL: `postgresql://wager_app:${env.APP_DATABASE_PASSWORD}@127.0.0.1:${port}/wagering`,
    }),
    [WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity],
  );
  owner = new DataSource({
    type: 'postgres',
    url: `postgresql://wager_migrator:${env.MIGRATION_DATABASE_PASSWORD}@127.0.0.1:${port}/wagering`,
    synchronize: false,
  });
  await app.initialize();
  await owner.initialize();
}, 120_000);
afterAll(async () => {
  if (app?.isInitialized) await app.destroy();
  if (owner?.isInitialized) await owner.destroy();
  await run(['down', '--volumes', '--remove-orphans']);
}, 30_000);

interface Fixture {
  wallet: string;
  player: string;
}
const hash = 'a'.repeat(64);
async function seed(): Promise<Fixture> {
  const fixture = { wallet: crypto.randomUUID(), player: crypto.randomUUID() };
  await app.transaction(async (manager) => {
    const transactionId = crypto.randomUUID();
    await manager.query(
      "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'BRL',100)",
      [fixture.wallet, fixture.player],
    );
    await manager.query(
      "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,result_balance,processed_at) VALUES($1::uuid,'internal',$1::text,$1::text,$2,$3,$4,'opening','internal','OPENING',100,'BRL','PROCESSED',100,now())",
      [transactionId, hash, fixture.wallet, fixture.player],
    );
    await manager.query(
      "INSERT INTO wagering.wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,'CREDIT',100,'BRL',0,100)",
      [crypto.randomUUID(), fixture.wallet, transactionId],
    );
  });
  return fixture;
}
async function movement(f: Fixture, kind: 'BET' | 'REFUND' | 'ROLLBACK', reference?: string) {
  const id = crypto.randomUUID();
  await app.transaction(async (manager) => {
    const rows = await manager.query<Array<{ balance: string }>>(
      'SELECT balance FROM wagering.wallets WHERE id=$1 FOR UPDATE',
      [f.wallet],
    );
    const before = Money.from({ amount: rows[0]!.balance, currency: 'BRL' });
    const amount = Money.from({ amount: '25.00', currency: 'BRL' });
    const after = kind === 'BET' ? before.subtract(amount) : before.add(amount);
    await manager.query(
      "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,reference_transaction_id,result_balance,processed_at) VALUES($1::uuid,'provider',$1::text,$1::text,$2,$3,$4,'round','game',$5,25,'BRL','PROCESSED',$6::text,$6::uuid,$7,now())",
      [id, hash, f.wallet, f.player, kind, reference ?? null, after.toString()],
    );
    await manager.query(
      "INSERT INTO wagering.wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,25,'BRL',$5,$6)",
      [
        crypto.randomUUID(),
        f.wallet,
        id,
        kind === 'BET' ? 'DEBIT' : 'CREDIT',
        before.toString(),
        after.toString(),
      ],
    );
    await manager.query('UPDATE wagering.wallets SET balance=$1, version=version+1 WHERE id=$2', [
      after.toString(),
      f.wallet,
    ]);
  });
  return id;
}
async function verify(f: Fixture, balance: string, count: number) {
  const rows = await app.query<
    Array<{
      balance: string;
      version: number;
      entries: number;
      consistent: boolean;
    }>
  >(
    `SELECT w.balance, w.version, count(l.id)::integer AS entries,
    w.balance = coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0) AS consistent
    FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
    [f.wallet],
  );
  expect(rows[0]).toEqual({
    balance,
    version: count,
    entries: count,
    consistent: true,
  });
}
async function failureOf(operation: Promise<unknown>, message?: string) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (message) expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error('Expected SQL operation to fail');
}
async function denied(sql: string, params: unknown[] = [], source = app) {
  await failureOf(source.query(sql, params));
}

test('wallet constraints, identity and balance-version coordination resist direct runtime SQL', async () => {
  const f = await seed();
  const row = await app.getRepository(WalletEntity).findOneByOrFail({ id: f.wallet });
  expect(row.balance).toBe('100.00');
  for (const balance of ['-1', 'NaN', 'Infinity', '1000000000000000000']) {
    await denied(
      "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'BRL',$3)",
      [crypto.randomUUID(), crypto.randomUUID(), balance],
    );
  }
  await denied(
    "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'BRL',0)",
    [crypto.randomUUID(), f.player],
  );
  await denied(
    "INSERT INTO wagering.wallets(id,player_id,currency,balance,version) VALUES($1,$2,'BRL',0,2)",
    [crypto.randomUUID(), crypto.randomUUID()],
  );
  await denied(
    "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'ZZZ',0)",
    [crypto.randomUUID(), crypto.randomUUID()],
  );
  await denied('UPDATE wagering.wallets SET balance=99 WHERE id=$1', [f.wallet]);
  await denied('UPDATE wagering.wallets SET version=2 WHERE id=$1', [f.wallet]);
  await denied('UPDATE wagering.wallets SET player_id=$1 WHERE id=$2', [
    crypto.randomUUID(),
    f.wallet,
  ]);
  await verify(f, '100.00', 1);
});

test('wager uniqueness, valid values, wallet context and original terminal outcomes are enforced', async () => {
  const f = await seed();
  const bet = await movement(f, 'BET');
  const insert = (
    id: string,
    kind: string,
    amount: string,
    status = 'PENDING',
    player = f.player,
    key = id,
    external = id,
  ) =>
    app.query(
      "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status) VALUES($1,'provider',$2,$3,$4,$5,$6,'round','game',$7,$8,'BRL',$9)",
      [id, external, key, hash, f.wallet, player, kind, amount, status],
    );
  for (const [kind, amount, status] of [
    ['BAD', '25', 'PENDING'],
    ['BET', '0', 'PENDING'],
    ['BET', '-1', 'PENDING'],
    ['BET', 'NaN', 'PENDING'],
    ['BET', '1000000000000000000', 'PENDING'],
    ['BET', '25', 'BAD'],
    ['REFUND', '25', 'PENDING'],
    ['BET', '25', 'PROCESSED'],
  ] as const) {
    await failureOf(insert(
      crypto.randomUUID(),
      kind,
      amount,
      status
    ));
  }
  await failureOf(insert(
    crypto.randomUUID(),
    'BET',
    '25',
    'PENDING',
    crypto.randomUUID()
  ));
  await failureOf(insert(
    crypto.randomUUID(),
    'BET',
    '25',
    'PENDING',
    f.player,
    bet
  ));
  await failureOf(
    insert(
      crypto.randomUUID(),
      'BET',
      '25',
      'PENDING',
      f.player,
      crypto.randomUUID(),
      bet
    ),
  );
  await denied(
    "UPDATE wagering.wager_transactions SET status='PENDING',processed_at=NULL WHERE id=$1",
    [bet],
  );
  await denied('UPDATE wagering.wager_transactions SET result_balance=999 WHERE id=$1', [bet]);
  await denied('DELETE FROM wagering.wager_transactions WHERE id=$1', [bet]);
  await denied('TRUNCATE wagering.wager_transactions CASCADE');
  await denied('DELETE FROM wagering.wager_transactions WHERE id=$1', [bet], owner);
  await verify(f, '75.00', 2);
});

test('ledger arithmetic, transaction context, uniqueness and immutability are enforced', async () => {
  const f = await seed();
  const bet = await movement(f, 'BET');
  const ledger = await app
    .getRepository(WalletLedgerEntryEntity)
    .findOneByOrFail({ transactionId: bet });
  expect(ledger.amount).toBe('25.00');
  const insert =
    "INSERT INTO wagering.wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,'BRL',$6,$7)";
  for (const [direction, amount, before, after] of [
    ['DEBIT', '25', '100', '75'],
    ['CREDIT', '25', '100', '125'],
    ['DEBIT', '24', '100', '76'],
    ['DEBIT', '25', '100', '76'],
    ['DEBIT', '0', '100', '100'],
    ['DEBIT', '25', '0', '-25'],
  ] as const) {
    await denied(insert, [crypto.randomUUID(), f.wallet, bet, direction, amount, before, after]);
  }
  await denied(insert, [crypto.randomUUID(), crypto.randomUUID(), bet, 'DEBIT', '25', '100', '75']);
  for (const sql of [
    'UPDATE wagering.wallet_ledger_entries SET amount=1',
    'DELETE FROM wagering.wallet_ledger_entries',
    'TRUNCATE wagering.wallet_ledger_entries',
  ]) {
    await denied(sql);
    await denied(sql, [], owner);
  }
  await verify(f, '75.00', 2);
});

test('same-kind reversal races allow one winner, while a different kind is allowed', async () => {
  const f = await seed();
  const bet = await movement(f, 'BET');
  const results = await Promise.allSettled([
    movement(f, 'REFUND', bet),
    movement(f, 'REFUND', bet),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  for (const result of results) {
    if (result.status === 'rejected')
      expect(result.reason).toHaveProperty('driverError.code', '23505');
  }
  await verify(f, '100.00', 3);
  await movement(f, 'ROLLBACK', bet);
  await verify(f, '125.00', 4);
  const wrong = await seed();
  await failureOf(movement(wrong, 'REFUND', bet), 'context');
  await verify(wrong, '100.00', 1);
});

test('reference eligibility, reversal amount and pending/terminal immutability resist direct SQL', async () => {
  const f = await seed();
  const bet = await movement(f, 'BET');
  const reverse = (reference: string, amount: string) =>
    app.query(
      "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,reference_transaction_id,result_balance,processed_at) VALUES($1::uuid,'provider',$1::text,$1::text,$2,$3,$4,'round','game','REFUND',$5,'BRL','PROCESSED',$6::text,$6::uuid,100,now())",
      [crypto.randomUUID(), hash, f.wallet, f.player, amount, reference],
    );
  await failureOf(reverse(bet, '24'), 'Partial reversals');
  for (const terminal of ['REJECTED', 'FAILED']) {
    const id = crypto.randomUUID();
    await app.query(
      "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status) VALUES($1::uuid,'provider',$1::text,$1::text,$2,$3,$4,'round','game','BET',25,'BRL','PENDING')",
      [id, hash, f.wallet, f.player],
    );
    await failureOf(
      app.query('UPDATE wagering.wager_transactions SET amount=24 WHERE id=$1', [id]),
      'Business payload',
    );
    await failureOf(reverse(id, '25'), 'not eligible');
    await app.query(
      "UPDATE wagering.wager_transactions SET status=$1, failure_code='PERMANENT_PROCESSING_FAILURE',result_balance=75 WHERE id=$2",
      [terminal, id],
    );
    await failureOf(
      app.query('UPDATE wagering.wager_transactions SET result_balance=99 WHERE id=$1', [id]),
      'Terminal',
    );
    await failureOf(reverse(id, '25'), 'not eligible');
  }
  await denied('ALTER TABLE wagering.wallet_ledger_entries DISABLE TRIGGER ALL');
  await denied("SET session_replication_role = 'replica'");
  await verify(f, '75.00', 2);
});

test('excess scale is rejected before persistence; PostgreSQL itself rounds NUMERIC', async () => {
  expect(() => Money.from({ amount: '1.001', currency: 'BRL' })).toThrow();
  const rows = await app.query<Array<{ rounded: string }>>(
    "SELECT '1.001'::numeric(20,2)::text AS rounded",
  );
  expect(rows[0]?.rounded).toBe('1.00');
});

test('financial schema rolls back and reapplies with functions, triggers and permissions', async () => {
  const financialMigrationCount = Array.from(
    new Bun.Glob('*.sql').scanSync({ cwd: 'database/changelog/changes' }),
  ).filter((file) => file !== '001-initialize-schema.sql').length;
  await run(['run', '--rm', 'migrations', 'rollback-count', `--count=${financialMigrationCount}`]);
  const absent = await owner.query<
    Array<{ table_name: string | null; function_name: string | null }>
  >(
    "SELECT to_regclass('wagering.wallets')::text AS table_name, to_regprocedure('wagering.protect_wallet()')::text AS function_name",
  );
  expect(absent[0]).toEqual({ table_name: null, function_name: null });
  await run(['run', '--rm', 'migrations', 'update']);
  const f = await seed();
  await verify(f, '100.00', 1);
  await denied('TRUNCATE wagering.wallet_ledger_entries');
}, 60_000);
