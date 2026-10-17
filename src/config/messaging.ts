import { z } from 'zod';

const MESSAGING_CONFIG_SCHEMA = z.object({
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(43200).default(30),
  SQS_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(10).default(4),
  SQS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export function readMessagingConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = MESSAGING_CONFIG_SCHEMA.safeParse(env);
  if (!result.success)
    throw new Error(
      'Invalid messaging configuration: ' +
        result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  return result.data;
}
export type MessagingConfig = z.infer<typeof MESSAGING_CONFIG_SCHEMA>;
