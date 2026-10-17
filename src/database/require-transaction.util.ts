import type { EntityManager } from 'typeorm';

// Financial repositories must receive the manager from DataSource.transaction().
// Otherwise one save could commit while another part of the same operation fails.
export function requireTransaction(manager: EntityManager): void {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error('Financial writes and row locks require an active transaction');
  }
}
