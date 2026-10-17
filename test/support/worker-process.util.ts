import { waitFor } from '@test/support/financial.util';

export function spawnWorker(env: NodeJS.ProcessEnv) {
  const phases = new Set<string>();
  const child = Bun.spawn([process.execPath, 'test/fixtures/worker-process.ts'], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const errors = new Response(child.stderr).text();
  const output = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as { phase?: string };
        if (message.phase) phases.add(message.phase);
      }
    }
  })();
  async function phase(name: string) {
    await waitFor(async () => {
      if (child.exitCode !== null)
        throw new Error('Worker exited before barrier: ' + (await errors));
      return phases.has(name);
    }, 10000);
  }
  async function stop(expected = 0) {
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null, 10000);
    await output;
    const code = await child.exited;
    if (code !== expected) throw new Error(`Worker exit ${code}: ${await errors}`);
  }
  return {
    child,
    phase,
    stop,
    phases,
    diagnostics: () => errors,
  };
}
