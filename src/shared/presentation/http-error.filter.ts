import { safeErrorContext, writeLog } from '@/shared/infrastructure/logging/application.logger';
import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ZodError } from 'zod';
import { ApplicationError } from '@/shared/errors/application.error';
import { DomainError } from '@/shared/errors/domain.error';
import { isTransientDatabaseError } from '@/database/transient-error.util';

const APPLICATION_HTTP_STATUS: Record<ApplicationError['code'], number> = {
  WALLET_NOT_FOUND: 404,
  INVALID_LEDGER_CURSOR: 400,
  TRANSACTION_NOT_FOUND: 404,
  INVALID_WALLET_CONTEXT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  STALE_CLAIM: 409,
  WALLET_CONFLICT: 409,
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = 'Unexpected server error';
    if (isTransientDatabaseError(error)) {
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      message = 'Service temporarily unavailable; retry with the same idempotency key';
    }
    if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_REQUEST';
      message = 'Request validation failed';
    } else if (error instanceof ApplicationError) {
      status = APPLICATION_HTTP_STATUS[error.code];
      code = error.code;
      message = error.message;
    } else if (error instanceof DomainError) {
      status = 400;
      code = error.code;
      message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST';
      message = error.message;
    }
    // Database errors may contain SQL and credentials. Return a stable retry contract, never the driver error.
    const correlationId =
      http.getRequest<{ correlationId?: string }>().correlationId ?? crypto.randomUUID();
    writeLog(
      'http_request_failed',
      {
        ...safeErrorContext(error),
        correlationId,
        failureCode: code,
        httpStatus: status,
      },
      status >= 500 ? 'error' : 'warn',
    );
    this.adapterHost.httpAdapter.reply(
      http.getResponse<unknown>(),
      { code, message, correlationId },
      status,
    );
  }
}
