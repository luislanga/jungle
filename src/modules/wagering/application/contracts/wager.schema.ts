import { z } from 'zod';
import { WagerTransactionKind as Kind } from '@/shared/enums/wager.enum';
import {
  requiresWagerReference,
  allowsZeroWagerAmount,
  isSelfReference,
} from '@/shared/utils/wager.util';
import { MONEY_INPUT_SCHEMA } from '@/shared/contracts/money.schema';
import { IDENTIFIER_SCHEMA, UUID_SCHEMA } from '@/shared/contracts/identifier.schema';

export const IDEMPOTENCY_KEY_SCHEMA = IDENTIFIER_SCHEMA;
export const WAGER_BUSINESS_SCHEMA = z
  .strictObject({
    providerId: IDENTIFIER_SCHEMA,
    externalTransactionId: IDENTIFIER_SCHEMA,
    playerId: UUID_SCHEMA,
    walletId: UUID_SCHEMA,
    roundId: IDENTIFIER_SCHEMA,
    gameId: IDENTIFIER_SCHEMA,
    kind: z.enum([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]),
    money: MONEY_INPUT_SCHEMA,
    // README 7 allows WIN payloads both with and without a BET reference (optional referenceExternalTransactionId).
    referenceExternalTransactionId: IDENTIFIER_SCHEMA.optional(),
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
  messageId: IDENTIFIER_SCHEMA,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: WAGER_BUSINESS_SCHEMA.safeExtend({ idempotencyKey: IDEMPOTENCY_KEY_SCHEMA }),
});
