import type { ApplicationErrorDefinition } from '@/shared/errors/errors.constant';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorDefinition['code'];

  constructor(error: ApplicationErrorDefinition) {
    super(error.message);
    this.code = error.code;
    this.name = 'ApplicationError';
  }
}
