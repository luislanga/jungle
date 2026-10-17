import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallets', schema: 'wagering' })
export class WalletEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({
    name: 'currency',
    type: 'varchar',
    length: 3,
  })
  currency!: string;

  @Column({
    name: 'balance',
    type: 'numeric',
    precision: 20,
    scale: 2,
  })
  balance!: string;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
