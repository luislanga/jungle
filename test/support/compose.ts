export async function compose(
  project: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ['docker', 'compose', '--project-name', project, '-f', 'compose.yaml', ...args],
    {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}
