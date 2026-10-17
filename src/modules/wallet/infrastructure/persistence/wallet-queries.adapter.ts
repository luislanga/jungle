import type { DataSource } from 'typeorm';
import type { WalletQueries } from '@/shared/interfaces/wallet-queries.interface';
import type {
  LedgerCursor,
  LedgerQueryRow,
  ReconciliationRow,
} from '@/shared/interfaces/wallet.interface';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';

export class WalletQueriesAdapter implements WalletQueries {
  constructor(private readonly dataSource: DataSource) {}

  findById(id: string) {
    return new WalletRepository(this.dataSource.manager).findById(id);
  }

  listLedger(walletId: string, limit: number, cursor?: LedgerCursor) {
    // PostgreSQL stores microseconds vs JavaScript Date milliseconds. Preserve the
    // full database timestamp in the cursor so tied rows cannot be skipped or repeated.
    return this.dataSource.query<LedgerQueryRow[]>(
      `SELECT id,transaction_id,direction,amount,currency,balance_before,balance_after,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM wagering.wallet_ledger_entries WHERE wallet_id=$1
         AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid))
       ORDER BY created_at,id LIMIT $4`,
      [walletId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );
  }

  async reconcile(walletId: string) {
    // PostgreSQL gives one SELECT one consistent snapshot. Because financial writes
    // commit together, this sees the wallet and ledger both before or both after a
    // concurrent commit. It does not need a writer lock or a repair operation.
    const [row] = await this.dataSource.query<ReconciliationRow[]>(
      `WITH totals AS (
        SELECT w.id,w.currency,w.balance,
          coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0) AS calculated,
          count(l.id)::integer AS entries
        FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id
        WHERE w.id=$1 GROUP BY w.id
      ) SELECT id AS "walletId",currency,balance::text AS stored,
          round(calculated,2)::text AS calculated,round(balance-calculated,2)::text AS difference,
          balance=calculated AS consistent,entries AS "checkedEntries" FROM totals`,
      [walletId],
    );
    return row;
  }
}
