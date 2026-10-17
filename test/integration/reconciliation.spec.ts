import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { startHttpTest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
} from '@test/support/financial.util';
import { ReconciliationSignals } from '@/modules/wallet/infrastructure/observability/reconciliation-signals.service';
import { ReconcileWalletUseCase } from '@/modules/wallet/application/reconcile-wallet.use-case';
import type { ReconciliationResult } from '@/shared/interfaces/wallet.interface';

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

async function reconcile(id: string) {
  const response = await http.request(`/wallets/${id}/reconciliation`, {
    method: 'POST',
    headers: { 'x-correlation-id': 'reconciliation-test' },
  });
  return { response, body: (await response.json()) as ReconciliationResult };
}

test('reconciliation matches README for OPENING and zero wallets, with exact two-place strings', async () => {
  for (const [amount, checkedEntries] of [
    ['100.00', 1],
    ['0.00', 0],
  ] as const) {
    const wallet = await openTestWallet(db.app, amount);
    const { response, body } = await reconcile(wallet.id);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount, currency: 'BRL' },
      calculatedBalance: { amount, currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries,
    });
    await assertWalletLedger(db.app, wallet.id, amount);
  }
  expect((await reconcile(crypto.randomUUID())).response.status).toBe(404);
  expect((await reconcile('invalid')).response.status).toBe(400);
});

test('a privileged corruption fixture returns a signed discrepancy, logs it and increments a metric without repair', async () => {
  const wallet = await openTestWallet(db.app);
  await db.owner.query(
    'UPDATE wagering.wallets SET balance=96,version=version+1,updated_at=now() WHERE id=$1',
    [wallet.id],
  );
  const before = await db.app.query<unknown[]>(
    'SELECT balance,version FROM wagering.wallets WHERE id=$1',
    [wallet.id],
  );
  const signals = http.app.get(ReconciliationSignals),
    count = signals.discrepancyCount;
  const logs: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  let result: Awaited<ReturnType<typeof reconcile>>;
  try {
    result = await reconcile(wallet.id);
  } finally {
    output.mockRestore();
  }
  expect(result.response.status).toBe(200);
  expect(result.body).toMatchObject({
    consistent: false,
    checkedEntries: 1,
    difference: { amount: '-4.00', currency: 'BRL' },
    calculatedBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(signals.discrepancyCount).toBe(count + 1);
  expect(
    logs.some(
      (line) =>
        line.includes('wallet_reconciliation_discrepancy') &&
        line.includes('reconciliation-test') &&
        line.includes(wallet.id),
    ),
  ).toBe(true);
  expect(logs.join('')).not.toContain('100.00');
  expect(
    await db.app.query<unknown[]>('SELECT balance,version FROM wagering.wallets WHERE id=$1', [
      wallet.id,
    ]),
  ).toEqual(before);
  // Only this privileged fixture restores its intentional corruption after proving no repair occurred.
  await db.owner.query(
    'UPDATE wagering.wallets SET balance=100,version=version+1,updated_at=now() WHERE id=$1',
    [wallet.id],
  );
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('repeated snapshots stay consistent while financial writes commit concurrently', async () => {
  const wallet = await openTestWallet(db.app);
  const service = http.app.get(ReconcileWalletUseCase),
    process = financialServices(db.app).process;
  await Promise.all([
    (async () => {
      for (let index = 0; index < 20; index++)
        await process.execute(
          wagerCommand(wallet, { money: { amount: '1', currency: 'BRL' } }),
          TEST_CONTEXT,
        );
    })(),
    (async () => {
      for (let index = 0; index < 30; index++)
        expect((await service.execute(wallet.id, TEST_CONTEXT)).consistent).toBe(true);
    })(),
  ]);
  const { body } = await reconcile(wallet.id);
  expect(body.checkedEntries).toBe(21);
  expect(body.storedBalance.amount).toBe('80.00');
  await assertWalletLedger(db.app, wallet.id, '80.00');
});
