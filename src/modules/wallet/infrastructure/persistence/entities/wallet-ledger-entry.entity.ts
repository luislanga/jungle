import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallet_ledger_entries', schema: 'wagering' })
export class WalletLedgerEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'direction', type: 'text' })
  direction!: string;

  @Column({ name: 'amount', type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Column({ name: 'currency', type: 'varchar', length: 3 })
  currency!: string;

  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
