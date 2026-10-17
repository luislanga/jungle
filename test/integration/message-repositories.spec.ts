import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { InboxMessage } from '@/modules/messaging/domain/inbox-message.domain';
import { OutboxMessage } from '@/modules/messaging/domain/outbox-message.domain';
import { InboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/inbox-message.repository';
import { OutboxMessageRepository } from '@/modules/messaging/infrastructure/persistence/repositories/outbox-message.repository';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const PAYLOAD_HASH = 'a'.repeat(64);
const CLAIM_OPTIONS = { owner: 'worker', limit: 2, leaseMs: 30_000 };
async function zeroWallet() {
  const id = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await db.app.query(
    "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'BRL',0)",
    [id, playerId],
  );
  return { id, playerId };
}
async function outbox() {
  const { id: walletId } = await zeroWallet(),
    id = crypto.randomUUID();
  const occurredAt = new Date();
  return OutboxMessage.rehydrate({
    id,
    aggregateId: walletId,
    eventType: 'Test',
    payload: {
      eventId: id,
      eventType: 'Test',
      version: 1,
      aggregateId: walletId,
      correlationId: 'test',
      occurredAt: occurredAt.toISOString(),
      data: {},
    },
    occurredAt,
    attempts: 0,
  });
}
async function pending() {
  const w = await zeroWallet(),
    id = crypto.randomUUID();
  await db.app.query(
    "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id) VALUES($1::uuid,'p',$1::text,$1::text,$2,$3,$4,'r','g','REFUND',1,'BRL','PENDING_REFERENCE','missing')",
    [id, PAYLOAD_HASH, w.id, w.playerId],
  );
  await db.app.transaction((m) =>
    new PendingReferenceWorkRepository(m).schedule(id, new Date(Date.now() + 300_000), new Date()),
  );
  return id;
}

test('Inbox concurrent deliveries share one record and reject a changed hash', async () => {
  const msg = InboxMessage.receive({
    consumerName: 'test',
    messageId: crypto.randomUUID(),
    payloadHash: PAYLOAD_HASH,
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      db.app.transaction(async (m) => {
        const repo = new InboxMessageRepository(m);
        const received = await repo.receive(msg);
        const replay = received.isProcessed();
        received.markProcessed(new Date());
        await repo.save(received);
        return replay;
      }),
    ),
  );
  expect(results.filter((replay) => !replay)).toHaveLength(1);
  let error: unknown;
  try {
    await db.app.transaction((m) =>
      new InboxMessageRepository(m).receive(
        InboxMessage.receive({
          consumerName: msg.consumerName,
          messageId: msg.messageId,
          payloadHash: 'b'.repeat(64),
        }),
      ),
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toHaveProperty('code', 'INBOX_PAYLOAD_CONFLICT');
});

test('enqueue participates in caller rollback; two concurrent claims are disjoint', async () => {
  const discarded = await outbox();
  try {
    await db.app.transaction(async (m) => {
      await new OutboxMessageRepository(m).enqueue(discarded);
      throw new Error('rollback');
    });
  } catch (error) {
    expect((error as Error).message).toBe('rollback');
  }
  const [count] = await db.app.query<Array<{ count: number }>>(
    'SELECT count(*)::integer AS count FROM wagering.outbox_messages WHERE id=$1',
    [discarded.id],
  );
  expect(count?.count).toBe(0);
  for (let i = 0; i < 4; i++) {
    const msg = await outbox();
    await db.app.transaction((m) => new OutboxMessageRepository(m).enqueue(msg));
  }
  const claims = await Promise.all(
    ['one', 'two'].map((owner) =>
      db.app.transaction((m) =>
        new OutboxMessageRepository(m).claimDue({ ...CLAIM_OPTIONS, owner }),
      ),
    ),
  );
  expect(claims[0]).toHaveLength(2);
  expect(claims[1]).toHaveLength(2);
  expect(new Set(claims.flat().map((c) => c.message.id)).size).toBe(4);
  for (const c of claims.flat())
    expect(
      await db.app.transaction((m) =>
        new OutboxMessageRepository(m).markPublished(c.message.id, c.token),
      ),
    ).toBe(true);
});

test('expired outbox claims recover; stale completion fails; retries retain the original event ID', async () => {
  const msg = await outbox();
  await db.app.transaction((m) => new OutboxMessageRepository(m).enqueue(msg));
  const [old] = await db.app.transaction((m) =>
    new OutboxMessageRepository(m).claimDue(CLAIM_OPTIONS),
  );
  await db.owner.query(
    "UPDATE wagering.outbox_messages SET claim_until=now()-interval '1 second' WHERE id=$1",
    [msg.id],
  );
  const [fresh] = await db.app.transaction((m) =>
    new OutboxMessageRepository(m).claimDue(CLAIM_OPTIONS),
  );
  expect(fresh!.token).not.toBe(old!.token);
  expect(
    await db.app.transaction((m) =>
      new OutboxMessageRepository(m).markPublished(msg.id, old!.token),
    ),
  ).toBe(false);
  expect(
    await db.app.transaction((m) =>
      new OutboxMessageRepository(m).scheduleRetry(msg.id, fresh!.token, new Date()),
    ),
  ).toBe(true);
  const [retry] = await db.app.transaction((m) =>
    new OutboxMessageRepository(m).claimDue(CLAIM_OPTIONS),
  );
  expect(retry!.message.id).toBe(msg.id);
  expect(retry!.message.payload.eventId).toBe(msg.id);
  expect(retry!.message.attempts).toBe(1);
  expect(
    await db.app.transaction((m) =>
      new OutboxMessageRepository(m).markPublished(msg.id, retry!.token),
    ),
  ).toBe(true);
});

test('pending-reference claims fence stale workers and persist retry counters', async () => {
  const id = await pending();
  const [old] = await db.app.transaction((m) =>
    new PendingReferenceWorkRepository(m).claimDue(CLAIM_OPTIONS),
  );
  await db.owner.query(
    "UPDATE wagering.pending_reference_work SET claim_until=now()-interval '1 second' WHERE transaction_id=$1",
    [id],
  );
  const [fresh] = await db.app.transaction((m) =>
    new PendingReferenceWorkRepository(m).claimDue(CLAIM_OPTIONS),
  );
  expect(
    await db.app.transaction((m) => new PendingReferenceWorkRepository(m).complete(id, old!.token)),
  ).toBe(false);
  expect(
    await db.app.transaction((m) =>
      new PendingReferenceWorkRepository(m).scheduleRetry(id, fresh!.token, new Date()),
    ),
  ).toBe(true);
  const [retry] = await db.app.transaction((m) =>
    new PendingReferenceWorkRepository(m).claimDue(CLAIM_OPTIONS),
  );
  expect(retry!.attempts).toBe(1);
  expect(
    await db.app.transaction((m) =>
      new PendingReferenceWorkRepository(m).complete(id, retry!.token),
    ),
  ).toBe(true);
});
