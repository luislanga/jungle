import type { InboxIdentity } from '@/shared/interfaces/messaging.interface';
import type { EventContext } from '@/shared/interfaces/event.interface';
import type { FailureCode, WagerTransactionStatus } from '@/shared/enums/wager.enum';
import type { MoneyProps } from '@/shared/interfaces/money.interface';
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

export interface WagerProcessingContext extends EventContext {
  inbox?: InboxIdentity;
}
export interface WagerProcessingResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}
