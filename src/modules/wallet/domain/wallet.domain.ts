import { DOMAIN_ERRORS } from '@/shared/errors/errors.constant';
import { DomainError } from '@/shared/errors/domain.error';
import type { Money } from '@/shared/domain/money.domain';
import type { WalletOpeningProps, WalletState } from '@/shared/interfaces/wallet.interface';

export class Wallet {
  private constructor(private readonly state: WalletState) {}

  static open(props: WalletOpeningProps, at = new Date()): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError(DOMAIN_ERRORS.INVALID_INITIAL_BALANCE);
    }
    // README.md 6.1 does not specify zero opening behavior. We accept it without
    // an OPENING transaction or ledger entry and the application creates those only for a positive balance.
    return Wallet.rehydrate({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
  }

  get id(): string {
    return this.state.id;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get currency(): string {
    return this.state.currency;
  }
  get balance(): Money {
    return this.state.balance;
  }
  get version(): number {
    return this.state.version;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.state.updatedAt);
  }

  debit(amount: Money, at = new Date()): void {
    this.assertNonnegative(amount);
    const balance = this.balance.subtract(amount);
    if (balance.isNegative()) throw new DomainError(DOMAIN_ERRORS.INSUFFICIENT_FUNDS);
    this.changeBalance(balance, at);
  }

  credit(amount: Money, at = new Date()): void {
    this.assertNonnegative(amount);
    this.changeBalance(this.balance.add(amount), at);
  }

  private assertNonnegative(amount: Money): void {
    if (amount.isNegative()) throw new DomainError(DOMAIN_ERRORS.INVALID_WALLET_MOVEMENT);
  }

  private changeBalance(balance: Money, at: Date): void {
    if (balance.equals(this.balance)) return;
    this.state.balance = balance;
    this.state.version++;
    this.state.updatedAt = new Date(at);
  }
}
