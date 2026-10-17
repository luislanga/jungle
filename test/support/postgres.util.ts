import { DataSource } from 'typeorm';
import { readDatabaseConfig } from '@/config/database';
import { createDatabaseDataSource } from '@/database/data-source';
import { WalletEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '@/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { InboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from '@/modules/messaging/infrastructure/persistence/entities/outbox-message.entity';
import { PendingReferenceWorkEntity } from '@/modules/messaging/infrastructure/persistence/entities/pending-reference-work.entity';
import { compose } from '@test/support/compose';

const TEST_ENTITIES = [
  WalletEntity,
  WalletLedgerEntryEntity,
  WagerTransactionEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
  PendingReferenceWorkEntity,
];

// Each suite owns its Compose project and volume; cleanup never touches the developer's database.
export async function startPostgresTest() {
  const project = `wagering-persistence-${crypto.randomUUID()}`;
  const env = {
    POSTGRES_PORT: '0',
    LOCALSTACK_PORT: '0',
    POSTGRES_PASSWORD: crypto.randomUUID(),
    APP_DATABASE_PASSWORD: crypto.randomUUID(),
    MIGRATION_DATABASE_PASSWORD: crypto.randomUUID(),
  };
  async function run(args: string[]) {
    const result = await compose(project, env, args);
    if (result.status !== 0) throw new Error(result.stderr + result.stdout);
    return result.stdout;
  }
  let app: DataSource | undefined;
  let owner: DataSource | undefined;
  async function close() {
    if (app?.isInitialized) await app.destroy();
    if (owner?.isInitialized) await owner.destroy();
    await run(['down', '--volumes', '--remove-orphans']);
  }
  try {
    await run(['up', '--detach', '--wait', 'postgres']);
    await run(['run', '--rm', 'migrations', 'update']);
    const port = (await run(['port', 'postgres', '5432'])).trim().split(':').at(-1);
    app = createDatabaseDataSource(
      readDatabaseConfig({
        DATABASE_URL: `postgresql://wager_app:${env.APP_DATABASE_PASSWORD}@127.0.0.1:${port}/wagering`,
      }),
      TEST_ENTITIES,
    );
    owner = new DataSource({
      type: 'postgres',
      synchronize: false,
      url: `postgresql://wager_migrator:${env.MIGRATION_DATABASE_PASSWORD}@127.0.0.1:${port}/wagering`,
    });
    await app.initialize();
    await owner.initialize();
    return {
      app,
      owner,
      run,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
