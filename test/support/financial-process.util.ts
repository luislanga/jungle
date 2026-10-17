import { waitFor } from '@test/support/financial.util';
import type {
  WagerCommand,
  WagerProcessingResult,
} from '@/shared/interfaces/wager-command.interface';

export interface FinancialProcessInput {
  command: WagerCommand;
  inbox?: { consumerName: string; messageId: string };
}
export type FinancialProcessResult =
  { ok: true; value: WagerProcessingResult } | { ok: false; code: string };

export async function startFinancialRace(databaseUrl: string, batches: FinancialProcessInput[][]) {
  const actors = batches.map((batch) => {
    let ready = false;
    let results: FinancialProcessResult[] | undefined;
    let backendPid: number | undefined;
    const child = Bun.spawn([process.execPath, 'test/fixtures/financial-process.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        WORKERS_ENABLED: 'false',
        DATABASE_LOCK_TIMEOUT_MS: '5000',
        DATABASE_TRANSACTION_TIMEOUT_MS: '10000',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const errors = new Response(child.stderr).text();
    const output = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const message = JSON.parse(line) as {
            phase?: string;
            connection?: number;
            results?: FinancialProcessResult[];
          };
          if (message.phase === 'ready') {
            ready = true;
            backendPid = message.connection;
          }
          if (message.phase === 'results') results = message.results;
        }
      }
    })();
    return {
      child,
      get ready() {
        return ready;
      },
      get results() {
        return results;
      },
      get backendPid() {
        return backendPid;
      },
      release: async () => {
        await child.stdin.write(JSON.stringify(batch));
        await child.stdin.end();
      },
      finish: async () => {
        await waitFor(() => child.exitCode !== null, 15000);
        await output;
        if ((await child.exited) !== 0) throw new Error(await errors);
        if (!results) throw new Error('Financial process exited without results');
        return results;
      },
    };
  });
  try {
    await waitFor(() => {
      for (const actor of actors)
        if (actor.child.exitCode !== null) throw new Error('Financial process failed before ready');
      return actors.every((actor) => actor.ready);
    }, 10000);
    console.log(
      JSON.stringify({
        event: 'race_processes_ready',
        pids: actors.map((a) => a.child.pid),
        backendPids: actors.map((a) => a.backendPid),
      }),
    );
    await Promise.all(actors.map((actor) => actor.release()));
    return {
      actors,
      finish: async () => (await Promise.all(actors.map((a) => a.finish()))).flat(),
      close: async () => {
        for (const actor of actors) if (actor.child.exitCode === null) actor.child.kill('SIGKILL');
        await Promise.all(actors.map((a) => a.child.exited));
      },
    };
  } catch (error) {
    for (const actor of actors) if (actor.child.exitCode === null) actor.child.kill('SIGKILL');
    await Promise.all(actors.map((a) => a.child.exited));
    throw error;
  }
}
