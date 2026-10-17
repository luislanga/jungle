import type { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import { withTransaction } from '@/database/transaction';
import type { OutboxLagReader } from '@/shared/interfaces/health.interface';

export function createOutboxLagReader(
  dataSource: DataSource,
  databaseConfig: DatabaseConfig,
): OutboxLagReader {
  return async () => {
    const [row] = await withTransaction(dataSource, databaseConfig, (manager) =>
      manager.query<Array<{ seconds: string }>>(
        `SELECT coalesce(greatest(extract(epoch FROM (clock_timestamp()-min(occurred_at))),0),0)::text AS seconds FROM wagering.outbox_messages WHERE published_at IS NULL`,
      ),
    );
    return Number(row?.seconds ?? '0');
  };
}
