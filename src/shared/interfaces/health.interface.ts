export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');
export const OUTBOX_LAG_READER = Symbol('OUTBOX_LAG_READER');

export interface HealthChecks {
  check(): Promise<{ postgres: boolean; sqs: boolean }>;
}

export type OutboxLagReader = () => Promise<number>;
