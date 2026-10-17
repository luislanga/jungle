import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wager_transactions', schema: 'wagering' })
export class WagerTransactionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerId!: string;

  @Column({ name: 'external_transaction_id', type: 'text' })
  externalTransactionId!: string;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({
    name: 'payload_hash',
    type: 'varchar',
    length: 64,
  })
  payloadHash!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ name: 'round_id', type: 'text' })
  roundId!: string;

  @Column({ name: 'game_id', type: 'text' })
  gameId!: string;

  @Column({ name: 'kind', type: 'text' })
  kind!: string;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Column({
    name: 'currency',
    type: 'varchar',
    length: 3,
  })
  currency!: string;

  @Column({ name: 'status', type: 'text' })
  status!: string;

  @Column({
    name: 'reference_external_transaction_id',
    type: 'text',
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Column({
    name: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId!: string | null;

  @Column({
    name: 'failure_code',
    type: 'text',
    nullable: true,
  })
  failureCode!: string | null;

  @Column({
    name: 'result_balance',
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  resultBalance!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({
    name: 'processed_at',
    type: 'timestamptz',
    nullable: true,
  })
  processedAt!: Date | null;
}
