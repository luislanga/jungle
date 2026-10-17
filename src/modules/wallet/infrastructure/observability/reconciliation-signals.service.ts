import type { ReconciliationResult } from '@/shared/interfaces/wallet.interface';
import type { EventContext } from '@/shared/interfaces/event.interface';

// Keep the discrepancy counter independent of wallet IDs, so metrics do not grow
// a label for every player. The metrics endpoint will export this process counter.
export class ReconciliationSignals {
  private discrepancies = 0;

  get discrepancyCount(): number {
    return this.discrepancies;
  }

  recordDiscrepancy(result: ReconciliationResult, context: EventContext): void {
    this.discrepancies++;
    process.stdout.write(
      JSON.stringify({
        level: 'error',
        event: 'wallet_reconciliation_discrepancy',
        correlationId: context.correlationId,
        walletId: result.walletId,
        checkedEntries: result.checkedEntries,
      }) + '\n',
    );
  }
}
