import type { WalletQueries } from '@/shared/interfaces/wallet-queries.interface';
import { LEDGER_CURSOR_VERSION } from '@/shared/consts/ledger.constant';
import { decodeLedgerCursor, encodeLedgerCursor } from '@/shared/utils/ledger-cursor.util';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';
import type { LedgerPage } from '@/shared/interfaces/wallet.interface';

export class ListLedgerUseCase {
  constructor(private readonly queries: WalletQueries) {}

  async execute(walletId: string, limit: number, cursorValue?: string): Promise<LedgerPage> {
    const cursor = cursorValue ? decodeLedgerCursor(cursorValue, walletId) : undefined;
    const wallet = await this.queries.findById(walletId);

    if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);

    const rows = await this.queries.listLedger(walletId, limit + 1, cursor);
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      walletId,
      entries: page,
      nextCursor:
        rows.length > limit && last
          ? encodeLedgerCursor({
              version: LEDGER_CURSOR_VERSION,
              walletId,
              createdAt: last.created_at,
              id: last.id,
            })
          : null,
    };
  }
}
