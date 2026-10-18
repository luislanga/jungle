import { z } from 'zod';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import {
  requiresWagerReference,
  allowsZeroWagerAmount,
  isSelfReference,
} from '@/shared/utils/wager.util';
import { MONEY_INPUT_SCHEMA } from '@/shared/contracts/money.schema';

export const IDEMPOTENCY_KEY_SCHEMA = z.string().min(1);
export const WAGER_BUSINESS_SCHEMA = z
  .strictObject({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.enum([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]),
    money: MONEY_INPUT_SCHEMA,
    // README 7 allows WIN payloads both with and without a BET reference (optional referenceExternalTransactionId).
    referenceExternalTransactionId: z.string().min(1).optional(),
  })
  .refine((data) => !requiresWagerReference(data.kind) || !!data.referenceExternalTransactionId, {
    path: ['referenceExternalTransactionId'],
    message: 'Reference is required for this kind',
  })
  .refine(
    (data) => !isSelfReference(data.externalTransactionId, data.referenceExternalTransactionId),
    {
      path: ['referenceExternalTransactionId'],
      message: 'A transaction cannot reference itself',
    },
  )
  // README leaves zero amounts unspecified: we accept zero LOSS, and require positive money movements.
  .refine((data) => allowsZeroWagerAmount(data.kind) || data.money.amount !== '0.00', {
    path: ['money', 'amount'],
    message: 'Amount must be positive for this kind',
  });

export const WAGER_ENVELOPE_SCHEMA = z.strictObject({
  messageId: z.string().min(1),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: WAGER_BUSINESS_SCHEMA.safeExtend({ idempotencyKey: IDEMPOTENCY_KEY_SCHEMA }),
});
