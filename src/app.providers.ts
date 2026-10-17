import type { Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpErrorFilter } from '@/shared/presentation/http-error.filter';

export const APP_PROVIDERS: Provider[] = [{ provide: APP_FILTER, useClass: HttpErrorFilter }];
