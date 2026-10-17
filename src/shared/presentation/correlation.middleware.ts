import { Injectable } from '@nestjs/common';

@Injectable()
export class CorrelationMiddleware {
  use(
    request: { headers: Record<string, unknown>; correlationId?: string },
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId =
      typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128
        ? supplied
        : crypto.randomUUID();
    response.setHeader('x-correlation-id', request.correlationId);
    next();
  }
}
