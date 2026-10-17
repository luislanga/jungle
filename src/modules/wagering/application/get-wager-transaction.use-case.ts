import type { WagerQueries } from '@/shared/interfaces/wager-queries.interface';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';

export class GetWagerTransactionUseCase {
  constructor(private readonly queries: WagerQueries) {}

  async byId(transactionId: string): Promise<StoredWager> {
    return this.requireWager(await this.queries.findById(transactionId));
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<StoredWager> {
    return this.requireWager(
      await this.queries.findByExternalId(providerId, externalTransactionId),
    );
  }

  private requireWager(stored: StoredWager | null): StoredWager {
    if (!stored) throw new ApplicationError(APPLICATION_ERRORS.TRANSACTION_NOT_FOUND);
    return stored;
  }
}
