import type { z } from 'zod';
import type { WAGER_BUSINESS_SCHEMA } from '@/modules/wagering/application/contracts/wager.schema';

export type WagerBusinessData = z.infer<typeof WAGER_BUSINESS_SCHEMA>;

export interface WagerCommand {
  idempotencyKey: string;
  payloadHash: string;
  data: WagerBusinessData;
}

export interface SqsWagerMessage {
  messageId: string;
  occurredAt: string;
  command: WagerCommand;
}
