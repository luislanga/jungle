import { Injectable } from '@nestjs/common';
import { writeLog } from '@/shared/infrastructure/logging/application.logger';

@Injectable()
export class CorrelationMiddleware {
  use(
    request: {
      headers: Record<string, unknown>;
      correlationId?: string;
      method: string;
      route?: { path?: string };
      params?: Record<string, string>;
    },
    response: {
      setHeader(name: string, value: string): void;
      statusCode: number;
      once(event: string, callback: () => void): void;
    },
    next: () => void,
  ) {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId =
      typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128
        ? supplied
        : crypto.randomUUID();
    response.setHeader('x-correlation-id', request.correlationId);
    const started = performance.now();
    response.once('finish', () =>
      writeLog('http_request_completed', {
        correlationId: request.correlationId,
        method: request.method,
        route: request.route?.path ?? 'unmatched',
        httpStatus: response.statusCode,
        durationMs: performance.now() - started,
        ...(response.statusCode < 400
          ? {
              walletId: request.params?.walletId,
              transactionId: request.params?.transactionId,
              providerId: request.params?.providerId,
            }
          : {}),
      }),
    );
    next();
  }
}
