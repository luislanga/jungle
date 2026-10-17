import type { DataSource } from 'typeorm';
import type { WalletQueries } from '@/shared/interfaces/wallet-queries.interface';
import type { LedgerCursor, LedgerQueryRow } from '@/shared/interfaces/wallet.interface';
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
}
