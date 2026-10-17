import type { WalletQueries } from '@/shared/interfaces/wallet-queries.interface';
import type { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';
import type { EventContext } from '@/shared/interfaces/event.interface';
import type { ReconciliationResult } from '@/shared/interfaces/wallet.interface';

export class ReconcileWalletUseCase {
  constructor(
    private readonly queries: WalletQueries,
    private readonly signals: ReconciliationSignals,
  ) {}

  async execute(walletId: string, context: EventContext): Promise<ReconciliationResult> {
    const row = await this.queries.reconcile(walletId);

    if (!row) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);

    const result = {
      walletId: row.walletId,
      storedBalance: { amount: row.stored, currency: row.currency },
      calculatedBalance: { amount: row.calculated, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent,
      checkedEntries: row.checkedEntries,
    };

    if (!result.consistent) this.signals.recordDiscrepancy(result, context);
    return result;
  }
}
