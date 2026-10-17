import type { DomainErrorDefinition } from '@/shared/errors/errors.constant';

export class DomainError extends Error {
  public readonly code: DomainErrorDefinition['code'];

  constructor(error: DomainErrorDefinition) {
    super(error.message);
    this.code = error.code;
    this.name = 'DomainError';
  }
}
