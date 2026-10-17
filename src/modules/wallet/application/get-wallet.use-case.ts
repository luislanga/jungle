import type { WalletQueries } from '@/shared/interfaces/wallet-queries.interface';
import { ApplicationError } from '@/shared/errors/application.error';
import { APPLICATION_ERRORS } from '@/shared/errors/errors.constant';

export class GetWalletUseCase {
  constructor(private readonly queries: Pick<WalletQueries, 'findById'>) {}

  async execute(id: string) {
    const wallet = await this.queries.findById(id);
    if (!wallet) throw new ApplicationError(APPLICATION_ERRORS.WALLET_NOT_FOUND);
    return wallet;
  }
}
