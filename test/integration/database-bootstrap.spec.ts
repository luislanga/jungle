import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { DataSource, type EntityManager, EntitySchema } from 'typeorm';
import { readDatabaseConfig, type DatabaseConfig } from '@/config/database';
import { createDatabaseDataSource } from '@/database/data-source';
import { withTransaction } from '@/database/transaction';
import { compose } from '@test/support/compose';

interface NumericProbe {
  id: string;
  amount: string;
}

const PROBE_ENTITY = new EntitySchema<NumericProbe>({
  name: 'NumericProbe',
  tableName: 'numeric_probe',
  columns: {
    id: { type: 'uuid', primary: true },
    amount: {
      type: 'numeric',
      precision: 20,
      scale: 2,
    },
  },
});

const project = `wagering-test-${crypto.randomUUID()}`;
const env = {
  POSTGRES_PASSWORD: crypto.randomUUID(),
  APP_DATABASE_PASSWORD: crypto.randomUUID(),
  MIGRATION_DATABASE_PASSWORD: crypto.randomUUID(),
  POSTGRES_PORT: '0',
  APP_PORT: '0',
  APP2_PORT: '0',
  APP3_PORT: '0',
  LOCALSTACK_PORT: '0',
};
let migrator: DataSource;
let application: DataSource;
let transactionSettings: DatabaseConfig;
const migrationCount = Array.from(
  new Bun.Glob('*.sql').scanSync({ cwd: 'database/changelog/changes' }),
).length;

async function run(args: string[]): Promise<string> {
  const result = await compose(project, env, args);
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout;
}

async function port(service: string, internalPort: number): Promise<string> {
  const address = (await run(['port', service, String(internalPort)])).trim();
  const assigned = new URL(`http://${address}`).port;
  if (!assigned) throw new Error(`No published port for ${service}`);
  return assigned;
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
}

beforeAll(async () => {
  try {
    await run(['up', '--build', '--detach']);
  } catch (error) {
    const logs = await compose(project, env, ['logs', '--no-color', '--tail=60']);
    throw new Error(`${String(error)}\n${logs.stdout}\n${logs.stderr}`, { cause: error });
  }
  const databasePort = await port('postgres', 5432);
  migrator = new DataSource({
    type: 'postgres',
    url: `postgresql://wager_migrator:${env.MIGRATION_DATABASE_PASSWORD}@127.0.0.1:${databasePort}/wagering`,
    synchronize: false,
    logging: false,
  });
  await migrator.initialize();
  const config = readDatabaseConfig({
    DATABASE_URL: `postgresql://wager_app:${env.APP_DATABASE_PASSWORD}@127.0.0.1:${databasePort}/wagering`,
  });
  application = createDatabaseDataSource(config, [PROBE_ENTITY]);
  await application.initialize();
  transactionSettings = config;
}, 300_000);

beforeEach(async () => {
  await migrator.query(
    'CREATE TABLE IF NOT EXISTS wagering.numeric_probe (id uuid PRIMARY KEY, amount numeric(20,2) NOT NULL)',
  );
  await application.query('DELETE FROM wagering.numeric_probe');
});

afterAll(async () => {
  try {
    if (application?.isInitialized) await application.destroy();
    if (migrator?.isInitialized) await migrator.destroy();
  } finally {
    // Only this test's unique project and volume are removed; never the developer's database.
    await run(['down', '--volumes', '--remove-orphans']);
  }
}, 30_000);

test('complete environment starts only after healthy PostgreSQL and successful Liquibase', async () => {
  expect(application.options.synchronize).toBe(false);
  const history = await migrator.query<Array<{ id: string }>>('SELECT id FROM databasechangelog');
  expect(history).toContainEqual({ id: '001-initialize-schema' });
  expect(history).toHaveLength(migrationCount);
  expect(await run(['run', '--rm', '--no-deps', 'migrations', '--version'])).toContain('5.0.4');
  const queueSetup = JSON.parse(await run(['ps', '--all', '--format', 'json', 'queue-init'])) as {
    State: string;
    ExitCode: number;
  };
  expect(queueSetup.State).toBe('exited');
  expect(queueSetup.ExitCode).toBe(0);
  for (const service of ['app', 'app2', 'app3']) {
    const address = `http://127.0.0.1:${await port(service, 3000)}`;
    const response = await fetch(address);
    expect(response.status).toBe(404);
  }
}, 30_000);

test('repeated Compose startup does not reapply changes or remove existing data', async () => {
  const id = crypto.randomUUID();
  await application.getRepository(PROBE_ENTITY).save({ id, amount: '0.10' });
  const before = await migrator.query<unknown[]>(
    'SELECT id, dateexecuted, md5sum FROM databasechangelog',
  );
  await run(['up', '--build', '--detach']);
  const after = await migrator.query<unknown[]>(
    'SELECT id, dateexecuted, md5sum FROM databasechangelog',
  );
  expect(after).toEqual(before);
  expect((await application.getRepository(PROBE_ENTITY).findOneByOrFail({ id })).amount).toBe(
    '0.10',
  );
}, 60_000);

test('explicit SQL rollback and reapply work against PostgreSQL', async () => {
  await run(['stop', 'app', 'app2', 'app3']);
  await migrator.query('DROP TABLE wagering.numeric_probe');
  try {
    await run([
      'run',
      '--rm',
      '--no-deps',
      'migrations',
      'rollback-count',
      `--count=${migrationCount}`,
    ]);
    const absent = await migrator.query<Array<{ schema: string | null }>>(
      "SELECT to_regnamespace('wagering')::text AS schema",
    );
    expect(absent[0]?.schema).toBeNull();
    const history = await migrator.query<unknown[]>('SELECT id FROM databasechangelog');
    expect(history).toHaveLength(0);
  } finally {
    await run(['up', '--detach']);
  }
  const restored = await migrator.query<unknown[]>('SELECT id FROM databasechangelog');
  expect(restored).toHaveLength(migrationCount);
}, 60_000);

test('failed migration blocks app startup and rolls back its partial SQL', async () => {
  const id = crypto.randomUUID();
  await application.getRepository(PROBE_ENTITY).save({ id, amount: '5.00' });
  await run(['stop', 'app', 'app2', 'app3']);
  try {
    const result = await compose(project, env, [
      '-f',
      'test/fixtures/compose.migration-failure.yaml',
      'up',
      '--detach',
    ]);
    expect(result.status).not.toBe(0);
    const running = await run(['ps', '--status', 'running', '--services']);
    expect(running.split('\n')).not.toContain('app');
    expect(running.split('\n')).not.toContain('app2');
    expect(running.split('\n')).not.toContain('app3');
    const tables = await migrator.query<Array<{ failed: string | null }>>(
      "SELECT to_regclass('wagering.failed_probe')::text AS failed",
    );
    expect(tables[0]?.failed).toBeNull();
    expect((await application.getRepository(PROBE_ENTITY).findOneByOrFail({ id })).amount).toBe(
      '5.00',
    );
  } finally {
    await run(['up', '--detach']);
  }
}, 60_000);

test('runtime and migrator have separate database permissions', async () => {
  for (const source of [application, migrator]) {
    const roles = await source.query<Array<{ rolsuper: boolean; rolcreaterole: boolean }>>(
      'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    expect(roles[0]).toEqual({ rolsuper: false, rolcreaterole: false });
  }
  expect(
    await failureOf(application.query('CREATE TABLE wagering.forbidden (id uuid)')),
  ).toHaveProperty('message', expect.stringContaining('permission denied'));
  expect(
    await failureOf(application.query('SELECT * FROM public.databasechangelog')),
  ).toHaveProperty('message', expect.stringContaining('permission denied'));
});

test('NUMERIC round-trips exact strings using the PostgreSQL driver', async () => {
  const id = crypto.randomUUID();
  const money = '999999999999999999.99';
  await withTransaction(application, transactionSettings, (manager) =>
    manager.getRepository(PROBE_ENTITY).save({ id, amount: money }),
  );
  const stored = await application.getRepository(PROBE_ENTITY).findOneByOrFail({ id });
  expect(stored.amount).toBe(money);
  expect(typeof stored.amount).toBe('string');
});

test('transaction callback shares one manager and rolls back all writes on error', async () => {
  const failure = new Error('abort all writes');
  expect(
    await failureOf(
      withTransaction(application, transactionSettings, async (manager) => {
        expect(manager).not.toBe(application.manager);
        expect(manager.queryRunner?.isTransactionActive).toBe(true);
        await manager.getRepository(PROBE_ENTITY).save({ id: crypto.randomUUID(), amount: '0.10' });
        await manager.getRepository(PROBE_ENTITY).save({ id: crypto.randomUUID(), amount: '0.20' });
        throw failure;
      }),
    ),
  ).toBe(failure);
  expect(await application.getRepository(PROBE_ENTITY).count()).toBe(0);
});

test('timeouts and READ COMMITTED are transaction-local', async () => {
  await withTransaction(application, transactionSettings, async (manager) => {
    const settings = await manager.query<
      Array<{
        isolation: string;
        lock: string;
        timeout: string;
      }>
    >(
      `SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('lock_timeout') AS lock,
              current_setting('transaction_timeout') AS timeout`,
    );
    expect(settings[0]).toEqual({
      isolation: 'read committed',
      lock: '2s',
      timeout: '5s',
    });
  });
  const outside = await application.query<Array<{ timeout: string }>>(
    "SELECT current_setting('lock_timeout') AS timeout",
  );
  expect(outside[0]?.timeout).toBe('0');
});

test('retry uses a fresh transaction and has no partial effects', async () => {
  const settings = {
    ...transactionSettings,
    DATABASE_RETRY_BASE_DELAY_MS: 0,
    DATABASE_RETRY_MAX_DELAY_MS: 0,
  };
  const managers = new Set<EntityManager>();
  let calls = 0;
  await withTransaction(application, settings, async (manager) => {
    managers.add(manager);
    await manager.getRepository(PROBE_ENTITY).save({ id: crypto.randomUUID(), amount: '1.00' });
    if (++calls === 1) {
      await manager.query(
        "DO $$ BEGIN RAISE EXCEPTION 'retry probe' USING ERRCODE='40P01'; END $$",
      );
    }
  });
  expect(calls).toBe(2);
  expect(managers.size).toBe(2);
  expect(await application.getRepository(PROBE_ENTITY).count()).toBe(1);
});

test('retry exhaustion is bounded and duplicate keys are not retried', async () => {
  const settings = {
    ...transactionSettings,
    DATABASE_TRANSACTION_MAX_ATTEMPTS: 2,
    DATABASE_RETRY_BASE_DELAY_MS: 0,
    DATABASE_RETRY_MAX_DELAY_MS: 0,
  };
  let attempts = 0;
  expect(
    await failureOf(
      withTransaction(application, settings, async (manager) => {
        attempts++;
        await manager.query(
          "DO $$ BEGIN RAISE EXCEPTION 'retry limit' USING ERRCODE='40001'; END $$",
        );
      }),
    ),
  ).toHaveProperty('message', expect.stringContaining('retry limit'));
  expect(attempts).toBe(2);
  attempts = 0;
  const id = crypto.randomUUID();
  expect(
    await failureOf(
      withTransaction(application, settings, async (manager) => {
        attempts++;
        await manager.getRepository(PROBE_ENTITY).insert({ id, amount: '1.00' });
        await manager.getRepository(PROBE_ENTITY).insert({ id, amount: '1.00' });
      }),
    ),
  ).toHaveProperty('message', expect.stringContaining('duplicate key'));
  expect(attempts).toBe(1);
  expect(await application.getRepository(PROBE_ENTITY).count()).toBe(0);
});
