import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { startHttpTest, jsonRequest } from '@test/support/http.util';
import {
  assertWalletLedger,
  financialServices,
  openTestWallet,
  TEST_CONTEXT,
  wagerCommand,
  waitFor,
} from '@test/support/financial.util';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';
import type {
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';
import { MAX_IDENTIFIER_LENGTH } from '@/shared/consts/identifier.constant';
import { WalletRepository } from '@/modules/wallet/infrastructure/persistence/repositories/wallet.repository';

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

async function submit(command: WagerCommand) {
  const init = jsonRequest(command.data);
  const response = await http.request('/wagering/transactions', {
    ...init,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': command.idempotencyKey,
      'x-correlation-id': 'wager-http',
    },
  });
  const result = (await response.json()) as WagerProcessingResult;
  return { response, result };
}

test('uppercase UUIDs from wallet opening support wagering, replay and ledger pagination', async () => {
  const playerId = crypto.randomUUID();
  const opened = await http.request(
    '/wallets',
    jsonRequest({
      playerId: playerId.toUpperCase(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  );
  expect(opened.status).toBe(201);
  const wallet = (await opened.json()) as { id: string; playerId: string };
  expect(wallet.playerId).toBe(playerId);
  const persistedWallet = await new WalletRepository(db.app.manager).findById(wallet.id);
  const command = wagerCommand(persistedWallet!);
  const first = await submit({
    ...command,
    data: {
      ...command.data,
      playerId: playerId.toUpperCase(),
      walletId: wallet.id.toUpperCase(),
    },
  });
  expect(first.response.status).toBe(200);
  expect((await submit(command)).result).toEqual({ ...first.result, idempotentReplay: true });
  const page = await http.request(`/wallets/${wallet.id}/ledger?limit=1`);
  const { nextCursor } = (await page.json()) as { nextCursor: string };
  const next = await http.request(
    `/wallets/${wallet.id.toUpperCase()}/ledger?limit=1&cursor=${nextCursor}`,
  );
  expect(next.status).toBe(200);
  const nextPage = (await next.json()) as { items: unknown[]; nextCursor: string | null };
  expect(nextPage.items).toHaveLength(1);
  expect(nextPage.nextCursor).toBeNull();
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('oversized identifiers return 400 without persisting financial work', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  const oversized = 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1);
  const IDENTIFIER_FIELDS = [
    'providerId',
    'externalTransactionId',
    'roundId',
    'gameId',
    'referenceExternalTransactionId',
  ] as const;
  for (const field of IDENTIFIER_FIELDS) {
    expect(
      (await submit({ ...command, data: { ...command.data, [field]: oversized } })).response.status,
    ).toBe(400);
  }
  expect((await submit({ ...command, idempotencyKey: oversized })).response.status).toBe(400);
  expect((await http.request(`/providers/${oversized}/wagering/transactions/unknown`)).status).toBe(
    400,
  );
  expect((await http.request(`/providers/unknown/wagering/transactions/${oversized}`)).status).toBe(
    400,
  );
  const [audit] = await db.app.query<
    Array<{
      wagers: number;
      entries: number;
      events: number;
      version: number;
    }>
  >(
    `SELECT w.version,
      (SELECT count(*)::int FROM wagering.wager_transactions WHERE wallet_id=w.id) AS wagers,
      (SELECT count(*)::int FROM wagering.wallet_ledger_entries WHERE wallet_id=w.id) AS entries,
      (SELECT count(*)::int FROM wagering.outbox_messages WHERE aggregate_id=w.id) AS events
     FROM wagering.wallets w WHERE w.id=$1`,
    [wallet.id],
  );
  expect(audit).toEqual({
    wagers: 1,
    entries: 1,
    events: 2,
    version: 1,
  });
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('maximum-length multibyte provider and external IDs fit the real PostgreSQL index', async () => {
  const wallet = await openTestWallet(db.app);
  const maximum = '界'.repeat(MAX_IDENTIFIER_LENGTH);
  const command = wagerCommand(wallet, {
    providerId: maximum,
    externalTransactionId: maximum,
  });
  command.idempotencyKey = 'k'.repeat(MAX_IDENTIFIER_LENGTH);
  expect((await submit(command)).response.status).toBe(200);
  expect((await submit(command)).result.idempotentReplay).toBe(true);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('HTTP processes all kinds, both WIN payloads and returns the original balance on replay', async () => {
  const wallet = await openTestWallet(db.app);
  const bet = wagerCommand(wallet);
  const first = await submit(bet);
  expect(first.response.status).toBe(200);
  expect(first.result.balance.amount).toBe('75.00');
  for (const command of [
    wagerCommand(wallet, { kind: Kind.Win, money: { amount: '5', currency: 'BRL' } }),
    wagerCommand(wallet, {
      kind: Kind.Win,
      money: { amount: '10', currency: 'BRL' },
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
    wagerCommand(wallet, { kind: Kind.Loss, money: { amount: '0', currency: 'BRL' } }),
    wagerCommand(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
    wagerCommand(wallet, {
      kind: Kind.Rollback,
      referenceExternalTransactionId: bet.data.externalTransactionId,
    }),
  ]) {
    const { response, result } = await submit(command);
    expect(response.status).toBe(200);
    expect(result.status).toBe(Status.Processed);
  }
  expect((await submit(bet)).result).toEqual({ ...first.result, idempotentReplay: true });
  const lookup = await http.request('/wagering/transactions/' + first.result.transactionId);
  const external = await http.request(
    `/providers/${bet.data.providerId}/wagering/transactions/${bet.data.externalTransactionId}`,
  );
  expect(lookup.status).toBe(200);
  expect(external.status).toBe(200);
  expect(await lookup.json()).toEqual(await external.json());
  await assertWalletLedger(db.app, wallet.id, '140.00');
});

test('HTTP distinguishes validation, identity conflicts, business rejection and missing resources', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  expect((await http.request('/wagering/transactions', jsonRequest(command.data))).status).toBe(
    400,
  );
  expect(
    (
      await http.request('/wagering/transactions', {
        ...jsonRequest({ ...command.data, kind: 'OPENING' }),
        headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
      })
    ).status,
  ).toBe(400);
  await submit(command);
  const changed: WagerCommand = {
    ...command,
    data: { ...command.data, money: { amount: '26', currency: 'BRL' } },
  };
  expect((await submit(changed)).response.status).toBe(409);
  expect((await submit({ ...command, idempotencyKey: crypto.randomUUID() })).response.status).toBe(
    409,
  );
  const rejected = await submit(
    wagerCommand(wallet, { money: { amount: '500', currency: 'BRL' } }),
  );
  expect(rejected.response.status).toBe(422);
  expect(rejected.result.failureCode).toBe(FailureCode.InsufficientFunds);
  expect((await http.request('/wagering/transactions/' + crypto.randomUUID())).status).toBe(404);
  expect((await http.request('/wagering/transactions/invalid')).status).toBe(400);
  expect((await http.request('/providers/unknown/wagering/transactions/unknown')).status).toBe(404);
  await assertWalletLedger(db.app, wallet.id, '75.00');
});

test('pending HTTP replay is read-only and returns the terminal outcome after explicit resume', async () => {
  const wallet = await openTestWallet(db.app);
  const bet = wagerCommand(wallet);
  const refund = wagerCommand(wallet, {
    kind: Kind.Refund,
    referenceExternalTransactionId: bet.data.externalTransactionId,
  });
  const pending = await submit(refund);
  expect(pending.response.status).toBe(202);
  expect(pending.result.status).toBe(Status.PendingReference);
  const replay = await submit(refund);
  expect(replay.response.status).toBe(202);
  expect(replay.result.idempotentReplay).toBe(true);
  await submit(bet);
  await db.owner.query(
    'UPDATE wagering.pending_reference_work SET next_attempt_at=now() WHERE transaction_id=$1',
    [pending.result.transactionId],
  );
  const claims = await db.app.transaction((manager) =>
    new PendingReferenceWorkRepository(manager).claimDue({
      owner: 'http-test',
      limit: 20,
      leaseMs: 30000,
    }),
  );
  const claim = claims.find((item) => item.transactionId === pending.result.transactionId)!;
  await financialServices(db.app).process.resume(claim.transactionId, claim.token, TEST_CONTEXT);
  const terminal = await submit(refund);
  expect(terminal.response.status).toBe(200);
  expect(terminal.result.status).toBe(Status.Processed);
  expect(terminal.result.idempotentReplay).toBe(true);
  await assertWalletLedger(db.app, wallet.id, '100.00');
});

test('database connection exhaustion returns 503 without exposing driver details and recovers', async () => {
  const wallet = await openTestWallet(db.app);
  const command = wagerCommand(wallet);
  try {
    // A real PostgreSQL role connection limit makes the runtime database unavailable
    // without changing Docker's randomly assigned host port when the container restarts.
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      "ALTER ROLE wager_app CONNECTION LIMIT 0; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='wager_app';",
    ]);
    const { response, result } = await submit(command);
    expect(response.status).toBe(503);
    expect(result).toHaveProperty('code', 'SERVICE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  } finally {
    await db.run([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'wagering',
      '-c',
      'ALTER ROLE wager_app CONNECTION LIMIT -1;',
    ]);
  }
  // The pool discards the connections that PostgreSQL terminated.
  // The provider retries the SAME key after 503, so recovery cannot duplicate a debit.
  await waitFor(async () => {
    const { response } = await submit(command);
    if (response.status === 503) return false;
    expect(response.status).toBe(200);
    return true;
  });
  await assertWalletLedger(db.app, wallet.id, '75.00');
}, 30_000);
