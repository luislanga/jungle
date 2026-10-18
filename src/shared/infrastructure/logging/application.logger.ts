import { postgresCause } from '@/database/postgres-error.util';

import { LOG_FIELDS } from '@/shared/consts/logging.constant';
import type { LogContext, LogLevel } from '@/shared/interfaces/logging.interface';
import type { EventEnvelope } from '@/shared/interfaces/event.interface';

export function writeLog(event: string, context: LogContext = {}, level: LogLevel = 'info'): void {
  try {
    const record: Record<string, unknown> = { timestamp: new Date().toISOString(), level, event };
    // Only explicitly allowed scalar fields are logged. Never serialize bodies,
    // headers, Error objects, SQL, amounts or arbitrary objects passed by a caller.
    for (const field of LOG_FIELDS) {
      const value = context[field];
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        record[field] = value;
    }
    process.stdout.write(JSON.stringify(record) + '\n');
  } catch {
    /* Logging must not turn committed financial work into a failed request. */
  }
}

export function safeErrorContext(error: unknown): LogContext {
  const cause = postgresCause(error);
  return {
    errorType: error instanceof Error ? error.name : 'UnknownError',
    errorCode:
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : undefined,
  };
}

export function eventLogContext(event: EventEnvelope): LogContext {
  const data = event.data;
  return {
    correlationId: event.correlationId,
    causationId: event.causationId,
    eventId: event.eventId,
    walletId: event.aggregateId,
    transactionId:
      typeof data === 'object' &&
      data !== null &&
      'transactionId' in data &&
      typeof data.transactionId === 'string'
        ? data.transactionId
        : undefined,
    providerId:
      typeof data === 'object' &&
      data !== null &&
      'providerId' in data &&
      typeof data.providerId === 'string'
        ? data.providerId
        : undefined,
  };
}
