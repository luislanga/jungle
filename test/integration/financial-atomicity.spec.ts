import { createOutboxStore } from '@/modules/messaging/infrastructure/persistence/worker-store.factory';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMessagingTest } from '@test/support/messaging.util';
import {
  assertWalletLedger,
  failureOf,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
} from '@test/support/financial.util';
import { OutboxPublisher } from '@/modules/messaging/application/outbox.publisher';

let db: Awaited<ReturnType<typeof startMessagingTest>>;
beforeAll(async () => {
  db = await startMessagingTest();
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);

async function snapshot(walletId: string) {
  return db.app.query<
    Array<{
      balance: string;
      version: number;
      wagers: number;
      ledger: number;
      events: number;
    }>
  >(
    `SELECT w.balance,w.version,
    (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=w.id) AS wagers,
    (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
    (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=w.id) AS events
    FROM wagering.wallets w WHERE w.id=$1`,
    [walletId],
  );
}

const FAULTS = [
  ['wager_transactions', 'INSERT', '', false],
  ['wager_transactions', 'UPDATE', '', false],
  ['wallet_ledger_entries', 'INSERT', '', false],
  ['wallets', 'UPDATE', '', false],
  ['inbox_messages', 'INSERT', '', false],
  ['inbox_messages', 'UPDATE', '', false],
  ['outbox_messages', 'INSERT', "WHEN (NEW.event_type='WagerTransactionProcessed')", false],
  ['outbox_messages', 'INSERT', "WHEN (NEW.event_type='WalletBalanceChanged')", false],
  ['wallet_ledger_entries', 'INSERT', '', true],
] as const;

for (const [table, operation, condition, deferred] of FAULTS) {
  test(`rollback after ${table} ${operation} ${condition} ${deferred ? 'at COMMIT' : ''}`, async () => {
    const wallet = await openTestWallet(db.app);
    const command = wagerCommand(wallet);
    const context = {
      ...TEST_CONTEXT,
      inbox: { consumerName: 'atomicity-test', messageId: crypto.randomUUID() },
    };
    const publisher = new OutboxPublisher(
      createOutboxStore(db.app, financialServices(db.app).config),
      db.sqs,
    );
    // Publish the opening first so any later claim would belong to the failed wager.
    await publisher.runOnce();
    const before = await snapshot(wallet.id);
    await db.owner.query(
      "CREATE FUNCTION wagering.test_atomicity_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected atomicity failure'; END $$",
    );
    await db.owner.query(
      `CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER test_atomicity_fault AFTER ${operation} ON wagering.${table} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW ${condition} EXECUTE FUNCTION wagering.test_atomicity_fault()`,
    );
    try {
      expect(
        await failureOf(financialServices(db.app).process.execute(command, context)),
      ).toHaveProperty('message', expect.stringContaining('injected atomicity failure'));
      expect(await snapshot(wallet.id)).toEqual(before);
      expect(
        await db.app.query('SELECT message_id FROM wagering.inbox_messages WHERE message_id=$1', [
          context.inbox.messageId,
        ]),
      ).toHaveLength(0);
      expect(await publisher.runOnce()).toEqual({ claimed: 0, published: 0 });
      await assertWalletLedger(db.app, wallet.id, '100.00');
    } finally {
      await db.owner.query(`DROP TRIGGER test_atomicity_fault ON wagering.${table}`);
      await db.owner.query('DROP FUNCTION wagering.test_atomicity_fault()');
    }
    const result = await financialServices(db.app).process.execute(command, context);
    expect(result.balance.amount).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);
    expect(await snapshot(wallet.id)).toEqual([
      {
        balance: '75.00',
        version: 2,
        wagers: 2,
        ledger: 2,
        events: 4,
      },
    ]);
    expect(
      await db.app.query(
        'SELECT message_id FROM wagering.inbox_messages WHERE message_id=$1 AND processed_at IS NOT NULL',
        [context.inbox.messageId],
      ),
    ).toHaveLength(1);
    expect(await publisher.runOnce()).toEqual({ claimed: 2, published: 2 });
    await assertWalletLedger(db.app, wallet.id, '75.00');
  });
}

test('runtime role cannot bypass financial defenses on a wallet created through the real use case', async () => {
  const wallet = await openTestWallet(db.app);
  const result = await financialServices(db.app).process.execute(
    wagerCommand(wallet),
    TEST_CONTEXT,
  );
  const before = await snapshot(wallet.id);
  for (const sql of [
    'UPDATE wagering.wallet_ledger_entries SET amount=1 WHERE wallet_id=$1',
    'DELETE FROM wagering.wallet_ledger_entries WHERE wallet_id=$1',
    'UPDATE wagering.wallets SET balance=-1,version=version+1 WHERE id=$1',
  ])
    expect(await failureOf(db.app.query(sql, [wallet.id]))).toBeInstanceOf(Error);
  for (const sql of [
    'TRUNCATE wagering.wallet_ledger_entries',
    'ALTER TABLE wagering.wallet_ledger_entries DISABLE TRIGGER ALL',
    "SET session_replication_role='replica'",
  ])
    expect(await failureOf(db.app.query(sql))).toBeInstanceOf(Error);
  expect(
    await failureOf(
      db.app.query('UPDATE wagering.wager_transactions SET result_balance=99 WHERE id=$1', [
        result.transactionId,
      ]),
    ),
  ).toBeInstanceOf(Error);
  expect(await snapshot(wallet.id)).toEqual(before);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});
