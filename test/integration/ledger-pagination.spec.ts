import { ledgerResponse } from '@/modules/wallet/presentation/ledger-response.mapper';
import { WalletQueriesAdapter } from '@/modules/wallet/infrastructure/persistence/wallet-queries.adapter';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { startHttpTest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
} from '@test/support/financial.util';
import { ListLedgerUseCase } from '@/modules/wallet/application/list-ledger.use-case';
import { LedgerDirection } from '@/shared/enums/wallet.enum';
import { encodeLedgerCursor } from '@/shared/utils/ledger-cursor.util';

let db: Awaited<ReturnType<typeof startPostgresTest>>,
  http: Awaited<ReturnType<typeof startHttpTest>>;
beforeAll(async () => {
  db = await startPostgresTest();
  http = await startHttpTest(db.app);
}, 120_000);
afterAll(async () => {
  await http?.app.close();
  await db?.close();
}, 30_000);

test('empty ledger, default limit and validation contracts use real HTTP', async () => {
  const wallet = await openTestWallet(db.app, '0');
  const response = await http.request(`/wallets/${wallet.id}/ledger`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], nextCursor: null });
  for (const query of [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'limit=no',
    'cursor=garbage',
    'unexpected=true',
    'limit=1&limit=2',
  ]) {
    expect((await http.request(`/wallets/${wallet.id}/ledger?${query}`)).status).toBe(400);
  }
  expect((await http.request(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  await assertWalletLedger(db.app, wallet.id, '0.00');
});

test('tied timestamps traverse without duplicates and later appends appear after the cursor', async () => {
  const wallet = await openTestWallet(db.app);
  const { process } = financialServices(db.app);
  for (let index = 0; index < 5; index++)
    await process.execute(
      wagerCommand(wallet, { money: { amount: '1', currency: 'BRL' } }),
      TEST_CONTEXT,
    );
  const service = new ListLedgerUseCase(new WalletQueriesAdapter(db.app));
  const first = ledgerResponse(await service.execute(wallet.id, 2));
  expect(first.items).toHaveLength(2);
  expect(first.items[0]?.direction).toBe(LedgerDirection.Credit);
  expect(first.items[0]?.balanceBefore.amount).toBe('0.00');
  await process.execute(
    wagerCommand(wallet, { money: { amount: '1', currency: 'BRL' } }),
    TEST_CONTEXT,
  );
  const ids = first.items.map((item) => item.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = ledgerResponse(await service.execute(wallet.id, 2, cursor));
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  }
  expect(ids).toHaveLength(7);
  expect(new Set(ids).size).toBe(7);
  await assertWalletLedger(db.app, wallet.id, '94.00');
});

test('microsecond ties and wallet-bound cursors preserve every existing row', async () => {
  const wallet = await openTestWallet(db.app, '96');
  const service = new ListLedgerUseCase(new WalletQueriesAdapter(db.app));
  // The owner creates complete movements at the same microsecond timestamp.
  // This tests pagination without changing or bypassing immutable ledger history.
  await db.owner.transaction(async (manager) => {
    for (const [before, after] of [
      ['96.00', '97.00'],
      ['97.00', '98.00'],
      ['98.00', '99.00'],
    ] as const) {
      const id = crypto.randomUUID();
      await manager.query(
        `INSERT INTO wagering.wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,processed_at,result_balance)
      VALUES($1::uuid,'tie-test',$1::text,$1::text,repeat('a',64),$2,$3,'round','game','WIN',1,'BRL','PROCESSED',now(),$4)`,
        [id, wallet.id, wallet.playerId, after],
      );
      await manager.query(
        `INSERT INTO wagering.wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
      VALUES($1,$2,$3,'CREDIT',1,'BRL',$4,$5,'2099-01-01T00:00:00.123456Z')`,
        [crypto.randomUUID(), wallet.id, id, before, after],
      );
      await manager.query(
        'UPDATE wagering.wallets SET balance=$2,version=version+1,updated_at=now() WHERE id=$1',
        [wallet.id, after],
      );
    }
  });
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const page = ledgerResponse(await service.execute(wallet.id, 1, cursor ?? undefined));
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  const another = await openTestWallet(db.app, '0');
  const encoded = encodeLedgerCursor({
    version: 1,
    walletId: wallet.id,
    createdAt: '2099-01-01T00:00:00.123456Z',
    id: ids.at(-1)!,
  });
  expect((await http.request(`/wallets/${another.id}/ledger?cursor=${encoded}`)).status).toBe(400);
  await assertWalletLedger(db.app, wallet.id, '99.00');
  await assertWalletLedger(db.app, another.id, '0.00');
});

test('HTTP defaults to fifty entries and resumes the last entry with its opaque cursor', async () => {
  const wallet = await openTestWallet(db.app);
  const { process } = financialServices(db.app);
  for (let index = 0; index < 50; index++)
    await process.execute(
      wagerCommand(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
      TEST_CONTEXT,
    );
  const response = await http.request(`/wallets/${wallet.id}/ledger`);
  const first = (await response.json()) as { items: unknown[]; nextCursor: string };
  expect(first.items).toHaveLength(50);
  expect(typeof first.nextCursor).toBe('string');
  const last = await http.request(`/wallets/${wallet.id}/ledger?cursor=${first.nextCursor}`);
  const page = (await last.json()) as { items: unknown[]; nextCursor: null };
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
  await assertWalletLedger(db.app, wallet.id, '50.00');
}, 15_000);
