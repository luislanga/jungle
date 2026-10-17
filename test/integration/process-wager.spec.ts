import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startPostgresTest } from '@test/support/postgres.util';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { PendingReferenceWorkRepository } from '@/modules/messaging/infrastructure/persistence/repositories/pending-reference-work.repository';
import {
  parseHttpWager,
  parseSqsWager,
} from '@/modules/wagering/application/contracts/wager-command.contract';
import { readDatabaseConfig } from '@/config/database';
import { readPendingReferenceConfig } from '@/config/pending-reference';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '@/shared/enums/wager.enum';
import { Money } from '@/shared/domain/money.domain';
import type { Wallet } from '@/modules/wallet/domain/wallet.domain';
import type { WagerBusinessData, WagerCommand } from '@/shared/interfaces/wager-command.interface';

let db: Awaited<ReturnType<typeof startPostgresTest>>,
  openWallet: OpenWalletUseCase,
  processWager: ProcessWagerTransactionUseCase;
const CONTEXT = { correlationId: 'process-test' };
const CLAIM_OPTIONS = { owner: 'resolver-test', limit: 100, leaseMs: 30_000 };
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
beforeAll(async () => {
  db = await startPostgresTest();
  const config = readDatabaseConfig({
    DATABASE_URL: db.app.options.type === 'postgres' ? db.app.options.url! : '',
  });
  openWallet = new OpenWalletUseCase(db.app, config);
  processWager = new ProcessWagerTransactionUseCase(db.app, config);
}, 120_000);
afterAll(async () => {
  await db?.close();
}, 30_000);
const open = (amount = '100') =>
  openWallet.execute({ playerId: crypto.randomUUID(), initialBalance: money(amount) }, CONTEXT);
function command(
  w: Wallet,
  kind: WagerBusinessData['kind'] = Kind.Bet,
  amount = '25',
  overrides: Partial<WagerBusinessData> = {},
  key: string = crypto.randomUUID(),
): WagerCommand {
  return parseHttpWager(
    {
      providerId: 'provider',
      externalTransactionId: crypto.randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: money(amount).toJSON(),
      ...overrides,
    },
    key,
  );
}
async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected failure');
}
async function verify(w: Wallet, balance: string, version: number, ledger: number) {
  const [row] = await db.app.query<
    Array<{ balance: string; version: number; entries: number; consistent: boolean }>
  >(
    "SELECT w.balance,w.version,count(l.id)::integer AS entries,w.balance=coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0) AS consistent FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id",
    [w.id],
  );
  expect(row).toEqual({ balance, version, entries: ledger, consistent: true });
}
async function events(w: Wallet) {
  return db.app.query<Array<{ event_type: string; count: number }>>(
    'SELECT event_type,count(*)::integer AS count FROM wagering.outbox_messages WHERE aggregate_id=$1 GROUP BY event_type ORDER BY event_type',
    [w.id],
  );
}
async function claim(id: string) {
  await db.owner.query(
    'UPDATE wagering.pending_reference_work SET next_attempt_at=now() WHERE transaction_id=$1',
    [id],
  );
  const claims = await db.app.transaction((m) =>
    new PendingReferenceWorkRepository(m).claimDue(CLAIM_OPTIONS),
  );
  const found = claims.find((c) => c.transactionId === id);
  if (!found) throw new Error('Expected due reference claim');
  return found;
}

test('BET, both WIN shapes and LOSS use one atomic processing path and exact event rules', async () => {
  const w = await open();
  const bet = command(w);
  expect((await processWager.execute(bet, CONTEXT)).balance.amount).toBe('75.00');
  const referenced = command(w, Kind.Win, '10', {
    referenceExternalTransactionId: bet.data.externalTransactionId,
  });
  expect((await processWager.execute(referenced, CONTEXT)).status).toBe(Status.Processed);
  expect((await processWager.execute(command(w, Kind.Win, '5'), CONTEXT)).status).toBe(
    Status.Processed,
  );
  expect((await processWager.execute(command(w, Kind.Loss, '0'), CONTEXT)).status).toBe(
    Status.Processed,
  );
  await verify(w, '90.00', 4, 4);
  expect(await events(w)).toEqual([
    { event_type: 'WagerTransactionProcessed', count: 5 },
    { event_type: 'WalletBalanceChanged', count: 4 },
  ]);
});

test('ordinary and reversal insufficiency are persisted rejections without ledger/version changes', async () => {
  const w = await open('10');
  const bet = await processWager.execute(command(w, Kind.Bet, '20'), CONTEXT);
  expect(bet.status).toBe(Status.Rejected);
  expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
  const win = command(w, Kind.Win, '20');
  await processWager.execute(win, CONTEXT);
  await processWager.execute(command(w, Kind.Bet, '30'), CONTEXT);
  const reversal = await processWager.execute(
    command(w, Kind.Rollback, '20', {
      referenceExternalTransactionId: win.data.externalTransactionId,
    }),
    CONTEXT,
  );
  expect(reversal.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  await verify(w, '0.00', 3, 3);
  expect((await events(w)).find((e) => e.event_type === 'WagerTransactionRejected')?.count).toBe(2);
});

test('replays return the original balance after later movements and across HTTP/SQS', async () => {
  const w = await open();
  const cmd = command(w);
  const first = await processWager.execute(cmd, CONTEXT);
  await processWager.execute(command(w, Kind.Bet, '10'), CONTEXT);
  const sqs = parseSqsWager({
    messageId: crypto.randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...cmd.data, idempotencyKey: cmd.idempotencyKey },
  });
  const context = {
    ...CONTEXT,
    inbox: { consumerName: 'wager-consumer', messageId: sqs.messageId },
  };
  const replay = await processWager.execute(sqs.command, context);
  expect(replay).toEqual({ ...first, idempotentReplay: true });
  expect(await processWager.execute(sqs.command, context)).toEqual(replay);
  expect(
    (
      await db.app.query<Array<{ count: number }>>(
        'SELECT count(*)::integer AS count FROM wagering.inbox_messages WHERE message_id=$1',
        [sqs.messageId],
      )
    )[0]?.count,
  ).toBe(1);
  await verify(w, '65.00', 3, 3);
  expect((await events(w)).find((e) => e.event_type === 'WagerTransactionProcessed')?.count).toBe(
    3,
  );
});

test('divergent keys, external identities and Inbox reuse are explicit conflicts with no partial writes', async () => {
  const w = await open();
  const cmd = command(w);
  await processWager.execute(cmd, CONTEXT);
  expect(
    await failureOf(
      processWager.execute(command(w, Kind.Bet, '26', {}, cmd.idempotencyKey), CONTEXT),
    ),
  ).toHaveProperty('code', 'IDEMPOTENCY_CONFLICT');
  expect(
    await failureOf(
      processWager.execute(
        command(w, Kind.Bet, '25', { externalTransactionId: cmd.data.externalTransactionId }),
        CONTEXT,
      ),
    ),
  ).toHaveProperty('code', 'EXTERNAL_TRANSACTION_CONFLICT');
  const w2 = await open();
  expect(
    await failureOf(
      processWager.execute(command(w2, Kind.Bet, '1', {}, cmd.idempotencyKey), CONTEXT),
    ),
  ).toHaveProperty('code', 'IDEMPOTENCY_CONFLICT');
  const ctx = { ...CONTEXT, inbox: { consumerName: 'consumer', messageId: crypto.randomUUID() } };
  await processWager.execute(command(w, Kind.Loss, '0'), ctx);
  const changed = command(w, Kind.Bet, '1');
  expect(await failureOf(processWager.execute(changed, ctx))).toHaveProperty(
    'code',
    'INBOX_PAYLOAD_CONFLICT',
  );
  expect(
    await db.app.query('SELECT id FROM wagering.wager_transactions WHERE idempotency_key=$1', [
      changed.idempotencyKey,
    ]),
  ).toHaveLength(0);
  await verify(w, '75.00', 2, 2);
  await verify(w2, '100.00', 1, 1);
});

test('same-key contenders debit once; distinct competing bets serialize to processed/rejected', async () => {
  const w = await open();
  const cmd = command(w);
  const duplicates = await Promise.all(
    Array.from({ length: 5 }, () => processWager.execute(cmd, CONTEXT)),
  );
  expect(duplicates.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  await verify(w, '75.00', 2, 2);
  const contest = await open();
  const race = await Promise.all([
    processWager.execute(command(contest, Kind.Bet, '80'), CONTEXT),
    processWager.execute(command(contest, Kind.Bet, '80'), CONTEXT),
  ]);
  expect(race.filter((r) => r.status === Status.Processed)).toHaveLength(1);
  expect(race.filter((r) => r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(1);
  await verify(contest, '20.00', 2, 2);
});

test('same-kind reversal races reject one; different kinds follow the literal README rule', async () => {
  const w = await open();
  const bet = command(w);
  await processWager.execute(bet, CONTEXT);
  const reference = { referenceExternalTransactionId: bet.data.externalTransactionId };
  const race = await Promise.all([
    processWager.execute(command(w, Kind.Refund, '25', reference), CONTEXT),
    processWager.execute(command(w, Kind.Refund, '25', reference), CONTEXT),
  ]);
  expect(race.filter((r) => r.status === Status.Processed)).toHaveLength(1);
  expect(race.filter((r) => r.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(
    1,
  );
  expect(
    (await processWager.execute(command(w, Kind.Rollback, '25', reference), CONTEXT)).status,
  ).toBe(Status.Processed);
  await verify(w, '125.00', 4, 4);
});

test('rollback reverses WIN and REFUND as debits', async () => {
  const w = await open();
  const bet = command(w);
  await processWager.execute(bet, CONTEXT);
  const refund = command(w, Kind.Refund, '25', {
    referenceExternalTransactionId: bet.data.externalTransactionId,
  });
  await processWager.execute(refund, CONTEXT);
  await processWager.execute(
    command(w, Kind.Rollback, '25', {
      referenceExternalTransactionId: refund.data.externalTransactionId,
    }),
    CONTEXT,
  );
  const win = command(w, Kind.Win, '10');
  await processWager.execute(win, CONTEXT);
  await processWager.execute(
    command(w, Kind.Rollback, '10', {
      referenceExternalTransactionId: win.data.externalTransactionId,
    }),
    CONTEXT,
  );
  await verify(w, '75.00', 6, 6);
});

test('reference context, kind, amount and rejected references produce auditable business rejections', async () => {
  const w = await open(),
    other = await open();
  const bet = command(w);
  await processWager.execute(bet, CONTEXT);
  expect(
    (
      await processWager.execute(
        command(other, Kind.Refund, '25', {
          referenceExternalTransactionId: bet.data.externalTransactionId,
        }),
        CONTEXT,
      )
    ).failureCode,
  ).toBe(FailureCode.ReferenceContextMismatch);
  expect(
    (
      await processWager.execute(
        command(w, Kind.Refund, '24', {
          referenceExternalTransactionId: bet.data.externalTransactionId,
        }),
        CONTEXT,
      )
    ).failureCode,
  ).toBe(FailureCode.ReferenceAmountMismatch);
  const loss = command(w, Kind.Loss, '0');
  await processWager.execute(loss, CONTEXT);
  expect(
    (
      await processWager.execute(
        command(w, Kind.Refund, '25', {
          referenceExternalTransactionId: loss.data.externalTransactionId,
        }),
        CONTEXT,
      )
    ).failureCode,
  ).toBe(FailureCode.InvalidReferenceKind);
  const rejected = command(w, Kind.Bet, '999');
  await processWager.execute(rejected, CONTEXT);
  expect(
    (
      await processWager.execute(
        command(w, Kind.Refund, '999', {
          referenceExternalTransactionId: rejected.data.externalTransactionId,
        }),
        CONTEXT,
      )
    ).failureCode,
  ).toBe(FailureCode.ReferenceNotProcessed);
  await verify(w, '75.00', 2, 2);
  await verify(other, '100.00', 1, 1);
});

test.each([Kind.Refund, Kind.Rollback])(
  '%s missing references persist once; public replay does not resume; claimed resume completes the original identity',
  async (kind) => {
    const w = await open();
    const bet = command(w);
    const refund = command(w, kind, '25', {
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    const accepted = await processWager.execute(refund, CONTEXT);
    expect(accepted.status).toBe(Status.PendingReference);
    expect((await processWager.execute(refund, CONTEXT)).idempotentReplay).toBe(true);
    await verify(w, '100.00', 1, 1);
    await processWager.execute(bet, CONTEXT);
    const pendingReplay = await processWager.execute(refund, CONTEXT);
    expect(pendingReplay.status).toBe(Status.PendingReference);
    expect(pendingReplay.balance.amount).toBe('100.00');
    const leased = await claim(accepted.transactionId);
    const result = await processWager.resume(leased.transactionId, leased.token, CONTEXT);
    expect(result.status).toBe(Status.Processed);
    expect(result.transactionId).toBe(accepted.transactionId);
    expect((await processWager.execute(refund, CONTEXT)).balance.amount).toBe('100.00');
    expect(
      await failureOf(processWager.resume(leased.transactionId, leased.token, CONTEXT)),
    ).toHaveProperty('code', 'STALE_CLAIM');
    await verify(w, '100.00', 3, 3);
    expect(
      (await events(w)).find((e) => e.event_type === 'WagerTransactionPendingReference')?.count,
    ).toBe(1);
  },
);

test('TTL and attempt exhaustion reject pending work independently; stale claims cannot change outcomes', async () => {
  for (const reason of ['ttl', 'attempts']) {
    const w = await open();
    const accepted = await processWager.execute(
      command(w, Kind.Win, '1', { referenceExternalTransactionId: crypto.randomUUID() }),
      CONTEXT,
    );
    if (reason === 'ttl')
      await db.owner.query(
        "UPDATE wagering.pending_reference_work SET expires_at=now()-interval '1 second' WHERE transaction_id=$1",
        [accepted.transactionId],
      );
    const config = readDatabaseConfig({
      DATABASE_URL: db.app.options.type === 'postgres' ? db.app.options.url! : '',
    });
    const useCase = new ProcessWagerTransactionUseCase(
      db.app,
      config,
      readPendingReferenceConfig({
        PENDING_REFERENCE_MAX_ATTEMPTS: reason === 'attempts' ? '1' : '10',
      }),
    );
    const leased = await claim(accepted.transactionId);
    expect(
      await failureOf(useCase.resume(accepted.transactionId, crypto.randomUUID(), CONTEXT)),
    ).toHaveProperty('code', 'STALE_CLAIM');
    const result = await useCase.resume(accepted.transactionId, leased.token, CONTEXT);
    expect(result.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
    await verify(w, '100.00', 1, 1);
  }
});

test('unavailable references schedule retries without repeated pending events', async () => {
  const w = await open();
  const accepted = await processWager.execute(
    command(w, Kind.Win, '1', { referenceExternalTransactionId: crypto.randomUUID() }),
    CONTEXT,
  );
  const leased = await claim(accepted.transactionId);
  expect((await processWager.resume(accepted.transactionId, leased.token, CONTEXT)).status).toBe(
    Status.PendingReference,
  );
  const [row] = await db.app.query<Array<{ attempts: number; claim_token: string | null }>>(
    'SELECT attempts,claim_token FROM wagering.pending_reference_work WHERE transaction_id=$1',
    [accepted.transactionId],
  );
  expect(row).toEqual({ attempts: 1, claim_token: null });
  expect(
    (await events(w)).find((e) => e.event_type === 'WagerTransactionPendingReference')?.count,
  ).toBe(1);
  await verify(w, '100.00', 1, 1);
});

test('missing wallets and player mismatches are rejected before accepting a wager', async () => {
  const w = await open();
  expect(
    await failureOf(
      processWager.execute(command(w, Kind.Bet, '1', { walletId: crypto.randomUUID() }), CONTEXT),
    ),
  ).toHaveProperty('code', 'WALLET_NOT_FOUND');
  expect(
    await failureOf(
      processWager.execute(command(w, Kind.Bet, '1', { playerId: crypto.randomUUID() }), CONTEXT),
    ),
  ).toHaveProperty('code', 'INVALID_WALLET_CONTEXT');
  await verify(w, '100.00', 1, 1);
});

test('failures after wager, ledger, wallet, Inbox or Outbox writes leave no partial effect', async () => {
  await db.owner.query(
    "CREATE FUNCTION wagering.test_process_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected wager failure'; END $$",
  );
  try {
    for (const [table, operation] of [
      ['wager_transactions', 'INSERT'],
      ['wager_transactions', 'UPDATE'],
      ['wallet_ledger_entries', 'INSERT'],
      ['wallets', 'UPDATE'],
      ['inbox_messages', 'INSERT'],
      ['inbox_messages', 'UPDATE'],
      ['outbox_messages', 'INSERT'],
    ] as const) {
      const w = await open(),
        cmd = command(w);
      const ctx = {
        ...CONTEXT,
        inbox: { consumerName: 'fault-test', messageId: crypto.randomUUID() },
      };
      const before = await events(w);
      await db.owner.query(
        `CREATE TRIGGER test_fault AFTER ${operation} ON wagering.${table} FOR EACH ROW EXECUTE FUNCTION wagering.test_process_failure()`,
      );
      try {
        expect(await failureOf(processWager.execute(cmd, ctx))).toHaveProperty(
          'message',
          expect.stringContaining('injected wager failure'),
        );
      } finally {
        await db.owner.query(`DROP TRIGGER test_fault ON wagering.${table}`);
      }
      await verify(w, '100.00', 1, 1);
      expect(await events(w)).toEqual(before);
      expect(
        await db.app.query('SELECT id FROM wagering.wager_transactions WHERE idempotency_key=$1', [
          cmd.idempotencyKey,
        ]),
      ).toHaveLength(0);
      expect(
        await db.app.query('SELECT message_id FROM wagering.inbox_messages WHERE message_id=$1', [
          ctx.inbox.messageId,
        ]),
      ).toHaveLength(0);
    }
  } finally {
    await db.owner.query('DROP FUNCTION wagering.test_process_failure()');
  }
});

test('credit overflow is an audited rejection and leaves the maximum balance unchanged', async () => {
  const w = await open('999999999999999999.99');
  const result = await processWager.execute(command(w, Kind.Win, '0.01'), CONTEXT);
  expect(result.status).toBe(Status.Rejected);
  expect(result.failureCode).toBe(FailureCode.MoneyOverflow);
  await verify(w, '999999999999999999.99', 1, 1);
});
