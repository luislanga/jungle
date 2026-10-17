import { z } from 'zod';
import { MONEY_INPUT_SCHEMA } from '@/shared/contracts/money.schema';

export const OPEN_WALLET_SCHEMA = z.strictObject({
  playerId: z.uuid(),
  initialBalance: MONEY_INPUT_SCHEMA,
});

export const WALLET_ID_SCHEMA = z.uuid();
