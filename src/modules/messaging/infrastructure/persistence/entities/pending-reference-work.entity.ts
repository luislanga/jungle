import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'pending_reference_work', schema: 'wagering' })
export class PendingReferenceWorkEntity {
  @PrimaryColumn({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({
    name: 'claim_owner',
    type: 'text',
    nullable: true,
  })
  claimOwner!: string | null;

  @Column({
    name: 'claim_token',
    type: 'uuid',
    nullable: true,
  })
  claimToken!: string | null;

  @Column({
    name: 'claim_until',
    type: 'timestamptz',
    nullable: true,
  })
  claimUntil!: Date | null;
}
