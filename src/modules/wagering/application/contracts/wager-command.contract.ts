import { canonicalHash } from '@/shared/utils/hash.util';
import type { SqsWagerMessage, WagerCommand } from '@/shared/interfaces/wager-command.interface';
import {
  IDEMPOTENCY_KEY_SCHEMA,
  WAGER_BUSINESS_SCHEMA,
  WAGER_ENVELOPE_SCHEMA,
} from '@/modules/wagering/application/contracts/wager.schema';

// HTTP requests and SQS messages carry the same wager data in different formats.
// These parsers validate both and produce the same command for wager processing.
// HTTP supplies the idempotency key separately; SQS includes it inside envelope.data.
// The payload hash uses only normalized business data, excluding the key and message metadata.

export function parseHttpWager(body: unknown, idempotencyKey: unknown): WagerCommand {
  const key = IDEMPOTENCY_KEY_SCHEMA.parse(idempotencyKey);
  const data = WAGER_BUSINESS_SCHEMA.parse(body);
  return {
    idempotencyKey: key,
    payloadHash: canonicalHash(data),
    data,
  };
}

export function parseSqsWager(body: unknown): SqsWagerMessage {
  const envelope = WAGER_ENVELOPE_SCHEMA.parse(body);
  const { idempotencyKey, ...data } = envelope.data;
  return {
    messageId: envelope.messageId,
    occurredAt: envelope.occurredAt,
    command: {
      idempotencyKey,
      payloadHash: canonicalHash(data),
      data,
    },
  };
}
