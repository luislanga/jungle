import { expect } from 'bun:test';
import type { DataSource } from 'typeorm';
import { readDatabaseConfig } from '@/config/database';
import { OpenWalletUseCase } from '@/modules/wallet/application/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';
import { parseHttpWager } from '@/modules/wagering/application/contracts/wager-command.contract';
import type { Wallet } from '@/modules/wallet/domain/wallet.domain';
import type { WagerBusinessData } from '@/shared/interfaces/wager-command.interface';
import { WagerTransactionKind } from '@/shared/enums/wager.enum';
import { Money } from '@/shared/domain/money.domain';

export const TEST_CONTEXT = { correlationId: 'financial-test' };

export function financialServices(dataSource: DataSource) {
  if (dataSource.options.type !== 'postgres') throw new Error('PostgreSQL required');
  const config = readDatabaseConfig({ DATABASE_URL: dataSource.options.url! });
  return {
    config,
    open: new OpenWalletUseCase(dataSource, config),
    process: new ProcessWagerTransactionUseCase(dataSource, config),
  };
}

export function openTestWallet(dataSource: DataSource, amount = '100') {
  return financialServices(dataSource).open.execute(
    {
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount, currency: 'BRL' }),
    },
    TEST_CONTEXT,
  );
}

export function wagerCommand(wallet: Wallet, overrides: Partial<WagerBusinessData> = {}) {
  return parseHttpWager(
    {
      providerId: 'provider-test',
      externalTransactionId: crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-test',
      gameId: 'game-test',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
    crypto.randomUUID(),
  );
}

export async function assertWalletLedger(
  dataSource: DataSource,
  walletId: string,
  balance: string,
) {
  const [row] = await dataSource.query<Array<{ balance: string; calculated: string }>>(
    `SELECT w.balance, coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated
     FROM wagering.wallets w LEFT JOIN wagering.wallet_ledger_entries l ON l.wallet_id=w.id WHERE w.id=$1 GROUP BY w.id`,
    [walletId],
  );
  expect(row).toEqual({ balance, calculated: balance });
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test barrier');
    await Bun.sleep(10);
  }
}

export async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
}
