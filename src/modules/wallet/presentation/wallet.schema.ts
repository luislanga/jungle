import { z } from 'zod';
import { MONEY_SCHEMA } from '@/shared/contracts/money.schema';
import { UUID_SCHEMA } from '@/shared/contracts/identifier.schema';

export const OPEN_WALLET_SCHEMA = z.strictObject({
  playerId: UUID_SCHEMA,
  initialBalance: MONEY_SCHEMA,
});

export const WALLET_ID_SCHEMA = UUID_SCHEMA;
