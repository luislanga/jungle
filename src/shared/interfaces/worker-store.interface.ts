import type {
  ClaimedOutbox,
  PendingReferenceClaim,
  WorkClaimOptions,
} from '@/shared/interfaces/messaging.interface';

export interface OutboxStore {
  claimDue(options: WorkClaimOptions): Promise<ClaimedOutbox[]>;
  markPublished(id: string, token: string): Promise<boolean>;
  scheduleRetry(id: string, token: string, nextAttemptAt: Date): Promise<boolean>;
}

export interface PendingWorkStore {
  claimDue(options: WorkClaimOptions): Promise<PendingReferenceClaim[]>;
}
