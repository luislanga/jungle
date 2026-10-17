// Each fixture starts its own Nest container and connection pool. stdin is the race barrier.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule } from '@/app.module';
import { parseHttpWager } from '@/modules/wagering/application/contracts/wager-command.contract';
import { ProcessWagerTransactionUseCase } from '@/modules/wagering/application/process-wager-transaction.use-case';

const INPUT_SCHEMA = z.array(
  z.object({
    command: z.object({ data: z.unknown(), idempotencyKey: z.string() }),
    inbox: z.object({ consumerName: z.string(), messageId: z.string() }).optional(),
  }),
);
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const database = app.get(DataSource);
  const [connection] = await database.query<Array<{ pid: number }>>(
    'SELECT pg_backend_pid() AS pid',
  );
  process.stdout.write(
    JSON.stringify({ phase: 'ready', pid: process.pid, connection: connection!.pid }) + '\n',
  );
  const inputs = INPUT_SCHEMA.parse(JSON.parse(await Bun.stdin.text()) as unknown);
  const useCase = app.get(ProcessWagerTransactionUseCase);
  const results = await Promise.all(
    inputs.map(async ({ command, inbox }) => {
      try {
        const value = await useCase.execute(parseHttpWager(command.data, command.idempotencyKey), {
          correlationId: `process-${process.pid}`,
          ...(inbox ? { inbox } : {}),
        });
        return { ok: true, value };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'UNEXPECTED';
        return { ok: false, code };
      }
    }),
  );
  process.stdout.write(JSON.stringify({ phase: 'results', pid: process.pid, results }) + '\n');
} finally {
  await app.close();
}
