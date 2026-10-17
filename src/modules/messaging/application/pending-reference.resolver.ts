import { RETRY_COUNT } from '@/shared/infrastructure/metrics/metrics';
import type { DataSource } from 'typeorm';
import type { DatabaseConfig } from '@/config/database';
import {
  readPendingReferenceConfig,
  type PendingReferenceConfig,
} from '@/config/pending-reference';
import { withTransaction } from '@/database/transaction';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import type { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '@/shared/enums/wager.enum';

export class PendingReferenceResolver {
  private readonly owner = crypto.randomUUID();

  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConfig: DatabaseConfig,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly config: PendingReferenceConfig = readPendingReferenceConfig(),
  ) {}

  async runOnce() {
    const claims = await withTransaction(this.dataSource, this.databaseConfig, (manager) =>
      new PendingReferenceWorkRepository(manager).claimDue({
        owner: this.owner,
        limit: this.config.PENDING_REFERENCE_BATCH_SIZE,
        leaseMs: this.config.PENDING_REFERENCE_LEASE_MS,
      }),
    );
    // Claims commit before processing. Another instance recovers them after lease expiry
    // if this instance dies. resume() fences each claim and reuses the financial rules.
    // Demo TTL/attempt limits are configurable and independent; production needs the
    // provider delay/SLA review described beside the defaults in config/pending-reference.ts.
    const results = await Promise.allSettled(
      claims.map((claim) =>
        this.processWager.resume(claim.transactionId, claim.token, {
          correlationId: `pending:${claim.transactionId}`,
          causationId: claim.transactionId,
        }),
      ),
    );
    const deferred = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === WagerTransactionStatus.PendingReference,
    ).length;
    RETRY_COUNT.inc({ source: 'pending_reference' }, deferred);
    return {
      claimed: claims.length,
      completed: results.filter(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.status !== WagerTransactionStatus.PendingReference,
      ).length,
      deferred,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  }
}
