import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';

export interface WagerQueries {
  findById(id: string): Promise<StoredWager | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<StoredWager | null>;
}
