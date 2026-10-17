import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';

function isRetryable(error: unknown): boolean {
  const cause: unknown = error instanceof QueryFailedError ? error.driverError : error;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return typeof cause.code === 'string' && ['40001', '40P01', '55P03'].includes(cause.code);
}

export async function withTransaction<Result>(
  dataSource: DataSource,
  settings: DatabaseConfig,
  work: (manager: EntityManager) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 1; attempt <= settings.DATABASE_TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      return await dataSource.transaction('READ COMMITTED', async (manager) => {
        await manager.query(
          `SELECT set_config('lock_timeout', $1, true),
                  set_config('statement_timeout', $2, true),
                  set_config('idle_in_transaction_session_timeout', $2, true),
                  set_config('transaction_timeout', $2, true)`,
          [
            `${settings.DATABASE_LOCK_TIMEOUT_MS}ms`,
            `${settings.DATABASE_TRANSACTION_TIMEOUT_MS}ms`,
          ],
        );
        // Use this manager for both wallet and ledger writes so they commit together.
        // A CHECK constraint cannot keep balances consistent across tables.
        // Reload state on retries and send external messages only after commit.
        return work(manager);
      });
    } catch (error) {
      if (attempt === settings.DATABASE_TRANSACTION_MAX_ATTEMPTS || !isRetryable(error))
        throw error;
      const delay = Math.min(
        settings.DATABASE_RETRY_MAX_DELAY_MS,
        settings.DATABASE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
      await Bun.sleep(Math.floor(Math.random() * delay));
    }
  }
  throw new Error('Transaction requires at least one attempt');
}
