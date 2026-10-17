import type { LOG_FIELDS } from '@/shared/consts/logging.constant';

export type LogContext = Partial<
  Record<(typeof LOG_FIELDS)[number], string | number | boolean | undefined>
>;
export type LogLevel = 'info' | 'warn' | 'error';
