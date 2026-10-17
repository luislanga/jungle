import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MetricsService } from '@/modules/health/application/metrics.service';
import { METRICS_REGISTRY } from '@/shared/infrastructure/metrics/metrics';
import { ENDPOINTS } from '@/shared/consts/endpoints.constant';

@Controller(ENDPOINTS.METRICS)
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', METRICS_REGISTRY.contentType)
  get() {
    return this.metrics.get();
  }
}
