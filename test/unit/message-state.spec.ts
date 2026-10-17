import { expect, test } from 'bun:test';
import { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import { WagerTransactionProcessed } from '@/modules/messaging/domain/events.domain';
import { WagerTransaction } from '@/modules/wagering/domain/wager-transaction.domain';
import { WagerTransactionKind } from '@/shared/enums/wager.enum';
import { Money } from '@/shared/domain/money.domain';

const at = new Date('2026-01-01T00:00:00Z');
function event() {
  const tx = WagerTransaction.create({
    id: 'tx',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Loss,
    money: Money.zero('BRL'),
  });
  tx.markProcessed(undefined, at);
  return WagerTransactionProcessed.from(tx, Money.zero('BRL'), {
    eventId: 'stable-id',
    correlationId: 'correlation',
    occurredAt: at,
  });
}

test('Inbox identity uses consumer and envelope ID; processing preserves its original time', () => {
  const time = new Date(at);
  const inbox = InboxMessage.receive(
    {
      messageId: 'envelope-id',
      consumerName: 'wager-worker',
      payloadHash: 'hash',
    },
    time,
  );
  expect(inbox.isProcessed()).toBe(false);
  expect(inbox.matchesPayload('hash')).toBe(true);
  expect(inbox.matchesPayload('other')).toBe(false);
  inbox.markProcessed(time);
  time.setFullYear(2000);
  inbox.markProcessed(new Date('2027-01-01Z'));
  inbox.processedAt?.setFullYear(2001);
  expect(inbox.processedAt).toEqual(at);
  expect(inbox.receivedAt).toEqual(at);
  const restored = InboxMessage.rehydrate({
    messageId: inbox.messageId,
    consumerName: inbox.consumerName,
    payloadHash: inbox.payloadHash,
    receivedAt: inbox.receivedAt,
    processedAt: inbox.processedAt!,
  });
  expect(restored.isProcessed()).toBe(true);
});

test('Outbox retains event identity and uses deterministic bounded exponential retry', () => {
  const source = event();
  const outbox = OutboxMessage.enqueue(source);
  expect(outbox.id).toBe(source.eventId);
  expect(outbox.payload.eventId).toBe('stable-id');
  expect(outbox.isDue(at)).toBe(true);
  outbox.scheduleRetry(
    at,
    1000,
    2000,
    () => 0.5
  );
  expect(outbox.attempts).toBe(1);
  expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 500);
  expect(outbox.isDue(at)).toBe(false);
  expect(outbox.isDue(new Date(at.getTime() + 500))).toBe(true);
  outbox.scheduleRetry(
    at,
    1000,
    2000,
    () => 0.5
  );
  outbox.scheduleRetry(
    at,
    1000,
    2000,
    () => 0.5
  );
  expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 1000);
  expect(outbox.id).toBe('stable-id');
  const payload = outbox.payload;
  payload.eventId = 'tampered';
  outbox.nextAttemptAt?.setFullYear(2000);
  expect(outbox.payload.eventId).toBe('stable-id');
  expect(outbox.nextAttemptAt?.getUTCFullYear()).toBe(2026);
  outbox.markPublished(at);
  outbox.markPublished(new Date('2027-01-01Z'));
  expect(outbox.publishedAt).toEqual(at);
  expect(outbox.isDue(new Date('2030-01-01Z'))).toBe(false);
  expect(() => outbox.scheduleRetry(at)).toThrow('Published');
});

test('Outbox rehydrates persisted attempts, dates and payload without re-enqueueing', () => {
  const payload = event().toJSON();
  const time = new Date(at);
  const message = OutboxMessage.rehydrate({
    id: payload.eventId,
    aggregateId: payload.aggregateId,
    eventType: payload.eventType,
    payload,
    occurredAt: time,
    attempts: 8,
    nextAttemptAt: time,
  });
  payload.eventId = 'changed';
  time.setFullYear(2000);
  expect(message.id).toBe('stable-id');
  expect(message.payload.eventId).toBe('stable-id');
  expect(message.attempts).toBe(8);
  expect(message.occurredAt).toEqual(at);
});
