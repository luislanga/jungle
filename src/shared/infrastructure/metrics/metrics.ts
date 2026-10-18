import type { ReconciliationResult } from '@/shared/interfaces/wallet.interface';
import type { EventContext } from '@/shared/interfaces/event.interface';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { WagerTransactionStatus } from '@/shared/enums/wager.enum';
import type { WagerProcessingResult } from '@/shared/interfaces/wager-command.interface';

// Scrape each process separately and sum counter rates (resets are normal on restart).
// Outbox lag and DLQ depth describe shared dependencies: aggregate those gauges with max, not sum.
export const METRICS_REGISTRY = new Registry();
const REGISTERS = [METRICS_REGISTRY];
const LATENCY_BUCKETS_SECONDS = [0.001, 0.01, 0.1, 1, 5, 15, 30];
export const OUTCOME_COUNT = new Counter({
  name: 'wager_outcomes_total',
  help: 'Committed wager transitions, excluding replay; includes internal OPENING.',
  labelNames: ['status'],
  registers: REGISTERS,
});
export const DUPLICATE_COUNT = new Counter({
  name: 'wager_duplicates_total',
  help: 'Successful durable idempotent replays.',
  registers: REGISTERS,
});
export const RETRY_COUNT = new Counter({
  name: 'wager_retries_total',
  help: 'Database retries, failed deliveries/publications and deferred reference evaluations.',
  labelNames: ['source'],
  registers: REGISTERS,
});
export const LOCK_CONFLICT_COUNT = new Counter({
  name: 'wager_lock_conflicts_total',
  help: 'Database lock timeouts/deadlocks, including final exhausted attempts.',
  registers: REGISTERS,
});
export const PROCESSING_DURATION = new Histogram({
  name: 'wager_processing_duration_seconds',
  help: 'Application processing latency including retries and failures.',
  labelNames: ['operation'],
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: REGISTERS,
});
export const DLQ_DEPTH = new Gauge({
  name: 'wager_dlq_messages',
  help: 'Actual approximate visible and in-flight DLQ backlog; never consumed by observation.',
  registers: REGISTERS,
});
export const OUTBOX_LAG = new Gauge({
  name: 'wager_outbox_lag_seconds',
  help: 'Age of oldest unpublished confirmed event, including leased work.',
  registers: REGISTERS,
});
export const RECONCILIATION_COUNT = new Counter({
  name: 'wager_reconciliation_discrepancies',
  help: 'Discrepancies observed by this process since startup.',
  registers: REGISTERS,
});
export const DEPENDENCY_UP = new Gauge({
  name: 'wager_metrics_dependency_up',
  help: 'Whether the last metrics collection reached a dependency.',
  labelNames: ['dependency'],
  registers: REGISTERS,
});
export const COLLECTION_ERRORS = new Counter({
  name: 'wager_metrics_collection_errors_total',
  help: 'Collection errors; failed gauges retain their last value.',
  labelNames: ['dependency'],
  registers: REGISTERS,
});

for (const status of Object.values(WagerTransactionStatus)) OUTCOME_COUNT.inc({ status }, 0);
for (const source of ['database', 'sqs', 'outbox', 'pending_reference'])
  RETRY_COUNT.inc({ source }, 0);

// Metrics are useful diagnostics, but a collection failure must not fail committed financial work.
export function recordMetrics(record: () => void): void {
  try {
    record();
  } catch {
    // Financial outcomes do not depend on the metrics backend.
  }
}

export function startProcessingTimer(operation: 'open_wallet' | 'submit' | 'resume'): () => void {
  try {
    const stopTimer = PROCESSING_DURATION.startTimer({ operation });
    return () => recordMetrics(stopTimer);
  } catch {
    return () => {};
  }
}

export function recordWagerResult(result: WagerProcessingResult): void {
  recordMetrics(() => {
    if (result.idempotentReplay) DUPLICATE_COUNT.inc();
    else OUTCOME_COUNT.inc({ status: result.status });
  });
}

export function recordReconciliationDiscrepancy(
  result: ReconciliationResult,
  context: EventContext,
): void {
  recordMetrics(() => RECONCILIATION_COUNT.inc());
  writeLog(
    'wallet_reconciliation_discrepancy',
    {
      correlationId: context.correlationId,
      walletId: result.walletId,
      checkedEntries: result.checkedEntries,
    },
    'error',
  );
}
