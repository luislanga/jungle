import { Not, type EntityManager } from 'typeorm';
import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WagerTransactionEntity } from '@/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { WagerTransactionMapper } from '@/modules/wagering/infrastructure/persistence/mappers/wager-transaction.mapper';
import { requireTransaction } from '@/database/require-transaction.util';
import type { Money } from '@/shared/domain/money.domain';
import { WagerTransactionKind, WagerTransactionStatus } from '@/shared/enums/wager.enum';
import type { StoredWager } from '@/shared/interfaces/wager-persistence.interface';

export class WagerTransactionRepository {
  constructor(private readonly manager: EntityManager) {}
  async findById(id: string, lock = false): Promise<StoredWager | null> {
    const query = this.manager
      .getRepository(WagerTransactionEntity)
      .createQueryBuilder('wager')
      .where('wager.id = :id', { id });
    if (lock) {
      requireTransaction(this.manager);
      query.setLock('pessimistic_write');
    }
    const row = await query.getOne();
    return row ? WagerTransactionMapper.toStored(row) : null;
  }
  async findByKey(idempotencyKey: string, lock = false): Promise<StoredWager | null> {
    const query = this.manager
      .getRepository(WagerTransactionEntity)
      .createQueryBuilder('wager')
      .where('wager.idempotency_key = :idempotencyKey', { idempotencyKey });
    if (lock) {
      requireTransaction(this.manager);
      query.setLock('pessimistic_write');
    }
    const row = await query.getOne();
    return row ? WagerTransactionMapper.toStored(row) : null;
  }
  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWager | null> {
    const row = await this.manager
      .getRepository(WagerTransactionEntity)
      .findOneBy({ providerId, externalTransactionId, kind: Not(WagerTransactionKind.Opening) });
    return row ? WagerTransactionMapper.toStored(row) : null;
  }
  async processedReversalKinds(referenceTransactionId: string): Promise<WagerTransactionKind[]> {
    const rows = await this.manager.getRepository(WagerTransactionEntity).find({
      select: { kind: true },
      where: { referenceTransactionId, status: WagerTransactionStatus.Processed },
    });
    return rows.map((row) => row.kind as WagerTransactionKind);
  }
  async insert(tx: WagerTransaction, resultBalance: Money | null = null): Promise<void> {
    requireTransaction(this.manager);
    await this.manager
      .getRepository(WagerTransactionEntity)
      .insert(WagerTransactionMapper.toPersistence(tx, resultBalance));
  }
  async save(tx: WagerTransaction, resultBalance: Money): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.getRepository(WagerTransactionEntity).update(tx.id, {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      processedAt: tx.processedAt ?? null,
      resultBalance: resultBalance.toString(),
    });
  }
}
