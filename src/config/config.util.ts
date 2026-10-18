import type { z } from 'zod';

// Report invalid setting names without exposing database URLs or credentials.
export function readConfig<Schema extends z.ZodType>(
  schema: Schema,
  name: string,
  env: NodeJS.ProcessEnv,
): z.output<Schema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join('.'))
      .filter(Boolean)
      .join(', ');
    throw new Error(`Invalid ${name} configuration${fields ? ': ' + fields : ''}`);
  }
  return result.data;
}
