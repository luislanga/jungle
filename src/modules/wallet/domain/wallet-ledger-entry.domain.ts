import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { DomainError } from '@/shared/errors/domain.error';
import type { Money } from '@/shared/domain/money.domain';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import type { LedgerEntryState } from '@/shared/interfaces/wallet.interface';

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(this.state);
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    if (
      !state.money.isPositive() ||
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative() ||
      !entry.isBalanced()
    ) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_LEDGER_ENTRY);
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state, createdAt: new Date(state.createdAt) });
  }

  get id(): string {
    return this.state.id;
  }
  get walletId(): string {
    return this.state.walletId;
  }
  get transactionId(): string {
    return this.state.transactionId;
  }
  get direction(): LedgerDirection {
    return this.state.direction;
  }
  get money(): Money {
    return this.state.money;
  }
  get balanceBefore(): Money {
    return this.state.balanceBefore;
  }
  get balanceAfter(): Money {
    return this.state.balanceAfter;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  isBalanced(): boolean {
    if (this.direction === LedgerDirection.Credit)
      return this.balanceBefore.add(this.money).equals(this.balanceAfter);
    if (this.direction === LedgerDirection.Debit)
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    return false;
  }
}
