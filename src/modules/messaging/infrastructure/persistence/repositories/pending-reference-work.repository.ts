import type { EntityManager } from 'typeorm';
import { PendingReferenceWorkEntity } from '@/modules/messaging/infrastructure/persistence/entities/pending-reference-work.entity';
import { requireTransaction } from '@/database/require-transaction.util';
import type {
  PendingReferenceClaim,
  WorkClaimOptions,
} from '@/shared/interfaces/messaging.interface';

export class PendingReferenceWorkRepository {
  constructor(private readonly manager: EntityManager) {}

  async schedule(transactionId: string, expiresAt: Date, nextAttemptAt: Date): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.getRepository(PendingReferenceWorkEntity).insert({
      transactionId,
      expiresAt,
      nextAttemptAt,
      attempts: 0,
    });
  }

  async claimDue(options: WorkClaimOptions): Promise<PendingReferenceClaim[]> {
    requireTransaction(this.manager);
    const token = crypto.randomUUID();
    return this.manager.query<PendingReferenceClaim[]>(
      `WITH due AS (
      SELECT w.transaction_id FROM wagering.pending_reference_work w
      JOIN wagering.wager_transactions t ON t.id=w.transaction_id
      WHERE t.status='PENDING_REFERENCE' AND (w.next_attempt_at<=clock_timestamp() OR w.expires_at<=clock_timestamp())
        AND (w.claim_until IS NULL OR w.claim_until<=clock_timestamp())
      ORDER BY w.next_attempt_at,w.transaction_id FOR UPDATE OF w SKIP LOCKED LIMIT $1
    ), claimed AS (
      UPDATE wagering.pending_reference_work w SET claim_owner=$2,claim_token=$3,
        claim_until=clock_timestamp()+$4 * interval '1 millisecond'
      FROM due WHERE w.transaction_id=due.transaction_id
      RETURNING w.transaction_id AS "transactionId",w.attempts,w.expires_at AS "expiresAt",w.claim_token AS token
    ) SELECT * FROM claimed`,
      [options.limit, options.owner, token, options.leaseMs],
    );
  }

  async findClaim(
    transactionId: string,
    token: string,
  ): Promise<PendingReferenceWorkEntity | null> {
    requireTransaction(this.manager);
    return this.manager
      .getRepository(PendingReferenceWorkEntity)
      .createQueryBuilder('work')
      .where(
        'work.transaction_id=:transactionId AND work.claim_token=:token AND work.claim_until>clock_timestamp()',
        { transactionId, token },
      )
      .setLock('pessimistic_write')
      .getOne();
  }

  async complete(transactionId: string, token: string): Promise<boolean> {
    requireTransaction(this.manager);
    const rows = await this.manager.query<Array<{ transaction_id: string }>>(
      `WITH completed AS (
      DELETE FROM wagering.pending_reference_work WHERE transaction_id=$1 AND claim_token=$2
        AND claim_until>clock_timestamp() RETURNING transaction_id
    ) SELECT * FROM completed`,
      [transactionId, token],
    );
    return rows.length === 1;
  }

  async scheduleRetry(transactionId: string, token: string, nextAttemptAt: Date): Promise<boolean> {
    requireTransaction(this.manager);
    const rows = await this.manager.query<Array<{ transaction_id: string }>>(
      `WITH retried AS (
      UPDATE wagering.pending_reference_work SET attempts=attempts+1,next_attempt_at=$3,
        claim_owner=NULL,claim_token=NULL,claim_until=NULL
      WHERE transaction_id=$1 AND claim_token=$2 AND claim_until>clock_timestamp() RETURNING transaction_id
    ) SELECT * FROM retried`,
      [transactionId, token, nextAttemptAt],
    );
    return rows.length === 1;
  }
}
