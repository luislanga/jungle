import { ENDPOINTS, HEALTH_ROUTES } from '@/shared/consts/endpoints.constant';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { HEALTH_CHECKS, type HealthChecks } from '@/shared/interfaces/health.interface';
import type { HttpStatusResponse } from '@/shared/interfaces/http.interface';

// Keep health public when the challenge's no-auth guard is replaced with an IdP guard.
@Controller(ENDPOINTS.HEALTH)
export class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthChecks) {}

  @Get(HEALTH_ROUTES.HEALTH_LIVENESS)
  live() {
    return { status: 'ok' };
  }

  @Get(HEALTH_ROUTES.HEALTH_READINESS)
  async ready(@Res({ passthrough: true }) response: HttpStatusResponse) {
    const { postgres, sqs } = await this.checks.check();
    const ready = postgres && sqs;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}
