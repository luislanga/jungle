import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';

let db: Awaited<ReturnType<typeof startPostgresTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const PAYLOAD_HASH = 'a'.repeat(64);
async function rejects(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return;
  }
  throw new Error('Expected SQL write to fail');
}
async function wallet() {
  const id = crypto.randomUUID();
  await db.app.query(
    "INSERT INTO wagering.wallets(id,player_id,currency,balance) VALUES($1,$2,'BRL',0)",
    [id, crypto.randomUUID()],
  );
  return id;
}
async function enqueue(walletId: string) {
  const id = crypto.randomUUID();
  const payload = {
    eventId: id,
    aggregateId: walletId,
    eventType: 'TestEvent',
    version: 1,
    occurredAt: new Date().toISOString(),
    data: {},
  };
  await db.app.query(
    'INSERT INTO wagering.outbox_messages(id,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,now())',
    [id, walletId, 'TestEvent', payload],
  );
  return id;
}

test('Inbox identity is consumer plus envelope ID; hash and duplicate constraints survive direct SQL', async () => {
  await db.app.query(
    'INSERT INTO wagering.inbox_messages(consumer_name,message_id,payload_hash) VALUES($1,$2,$3)',
    ['one', 'envelope', PAYLOAD_HASH],
  );
  await rejects(
    db.app.query(
      'INSERT INTO wagering.inbox_messages(consumer_name,message_id,payload_hash) VALUES($1,$2,$3)',
      ['one', 'envelope', PAYLOAD_HASH],
    ),
  );
  await db.app.query(
    'INSERT INTO wagering.inbox_messages(consumer_name,message_id,payload_hash) VALUES($1,$2,$3)',
    ['two', 'envelope', PAYLOAD_HASH],
  );
  await rejects(
    db.app.query(
      "INSERT INTO wagering.inbox_messages(consumer_name,message_id,payload_hash) VALUES('x','y','bad')",
    ),
  );
});

test('Outbox validates event identity, claims and attempts; stale tokens cannot complete a replacement claim', async () => {
  const id = await enqueue(await wallet());
  await rejects(
    db.app.query('UPDATE wagering.outbox_messages SET claim_owner=$1 WHERE id=$2', ['worker', id]),
  );
  await rejects(db.app.query('UPDATE wagering.outbox_messages SET attempts=-1 WHERE id=$1', [id]));
  await rejects(
    db.app.query(
      "UPDATE wagering.outbox_messages SET payload=jsonb_set(payload,'{eventId}','\"wrong\"') WHERE id=$1",
      [id],
    ),
  );
  const old = crypto.randomUUID(),
    fresh = crypto.randomUUID();
  await db.app.query(
    "UPDATE wagering.outbox_messages SET claim_owner='old',claim_token=$1,claim_until=now()-interval '1 second',attempts=2,next_attempt_at=now() WHERE id=$2",
    [old, id],
  );
  await db.app.query(
    "UPDATE wagering.outbox_messages SET claim_owner='new',claim_token=$1,claim_until=now()+interval '30 seconds' WHERE id=$2 AND claim_until<=now()",
    [fresh, id],
  );
  const stale = await db.app.query<unknown[]>(
    'WITH completed AS (UPDATE wagering.outbox_messages SET published_at=now(),claim_owner=NULL,claim_token=NULL,claim_until=NULL WHERE id=$1 AND claim_token=$2 AND claim_until>now() RETURNING id) SELECT * FROM completed',
    [id, old],
  );
  expect(stale).toHaveLength(0);
  // A separate connection sees committed retries and the current lease, rather than local process memory.
  const rows = await db.owner.query<Array<{ attempts: number; claim_token: string }>>(
    'SELECT attempts,claim_token FROM wagering.outbox_messages WHERE id=$1',
    [id],
  );
  expect(rows[0]).toEqual({ attempts: 2, claim_token: fresh });
});

test('pending-reference work persists independently of the business payload and enforces its relation', async () => {
  const id = crypto.randomUUID(),
    walletId = await wallet();
  const [w] = await db.app.query<Array<{ player_id: string }>>(
    'SELECT player_id FROM wagering.wallets WHERE id=$1',
    [walletId],
  );
  await db.app.query(
    "INSERT INTO wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id) VALUES($1::uuid,'p',$1::text,$1::text,$2,$3,$4,'r','g','REFUND',1,'BRL','PENDING_REFERENCE','missing')",
    [id, PAYLOAD_HASH, walletId, w!.player_id],
  );
  await db.app.query(
    "INSERT INTO wagering.pending_reference_work(transaction_id,next_attempt_at,expires_at) VALUES($1,now(),now()+interval '5 minutes')",
    [id],
  );
  await db.app.query(
    'UPDATE wagering.pending_reference_work SET attempts=attempts+1 WHERE transaction_id=$1',
    [id],
  );
  expect(
    (
      await db.owner.query<Array<{ attempts: number }>>(
        'SELECT attempts FROM wagering.pending_reference_work WHERE transaction_id=$1',
        [id],
      )
    )[0]?.attempts,
  ).toBe(1);
  await rejects(
    db.app.query(
      'INSERT INTO wagering.pending_reference_work(transaction_id,next_attempt_at,expires_at) VALUES($1,now(),now())',
      [crypto.randomUUID()],
    ),
  );
});

test('messaging migrations roll back and reapply without touching financial tables', async () => {
  const history = await db.owner.query<unknown[]>(
    'SELECT id,dateexecuted,md5sum FROM databasechangelog ORDER BY orderexecuted',
  );
  await db.run(['run', '--rm', 'migrations', 'update']);
  expect(
    await db.owner.query(
      'SELECT id,dateexecuted,md5sum FROM databasechangelog ORDER BY orderexecuted',
    ),
  ).toEqual(history);
  await db.run(['run', '--rm', 'migrations', 'rollback-count', '--count=3']);
  const [row] = await db.owner.query<
    Array<{
      inbox: string | null;
      outbox: string | null;
      work: string | null;
      wallets: string | null;
    }>
  >(
    "SELECT to_regclass('wagering.inbox_messages')::text AS inbox,to_regclass('wagering.outbox_messages')::text AS outbox,to_regclass('wagering.pending_reference_work')::text AS work,to_regclass('wagering.wallets')::text AS wallets",
  );
  expect(row).toEqual({
    inbox: null,
    outbox: null,
    work: null,
    wallets: 'wagering.wallets',
  });
  await db.run(['run', '--rm', 'migrations', 'update']);
  await enqueue(await wallet());
}, 60_000);
