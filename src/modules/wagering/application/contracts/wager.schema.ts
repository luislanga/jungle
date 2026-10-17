import { z } from 'zod';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import { Money } from '@/shared/domain/money.domain';

export const IDEMPOTENCY_KEY_SCHEMA = z.string().min(1);
const MONEY_SCHEMA = z
  .strictObject({ amount: z.string(), currency: z.literal('BRL') })
  .transform((props, ctx) => {
    try {
      return Money.from(props).toJSON();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid monetary amount' });
      return z.NEVER;
    }
  });

export const WAGER_BUSINESS_SCHEMA = z
  .strictObject({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.enum([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]),
    money: MONEY_SCHEMA,
    // README §7 allows WIN payloads both with and without a BET reference.
    referenceExternalTransactionId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.kind === Kind.Refund || data.kind === Kind.Rollback) &&
      !data.referenceExternalTransactionId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'Reference is required for this kind',
      });
    }
    if (data.referenceExternalTransactionId === data.externalTransactionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'A transaction cannot reference itself',
      });
    }
    // README §6.1 forbids negative input but does not define zero per kind.
    // Our agreed interpretation accepts zero LOSS and positive money-moving operations.
    if (data.kind !== Kind.Loss && data.money.amount === '0.00') {
      ctx.addIssue({
        code: 'custom',
        path: ['money', 'amount'],
        message: 'Amount must be positive for this kind',
      });
    }
  });

export const WAGER_ENVELOPE_SCHEMA = z.strictObject({
  messageId: z.string().min(1),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: WAGER_BUSINESS_SCHEMA.safeExtend({ idempotencyKey: IDEMPOTENCY_KEY_SCHEMA }),
});
