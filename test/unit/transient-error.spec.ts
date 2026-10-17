import { expect, test } from 'bun:test';
import { isTransientDatabaseError } from '@/database/transient-error.util';

test('HTTP distinguishes temporary database failures from permanent SQL and programming errors', () => {
  for (const code of ['40001', '40P01', '55P03', '08006', '57P01', 'ECONNREFUSED', 'ECONNRESET'])
    expect(isTransientDatabaseError({ code })).toBe(true);
  for (const error of [{ code: '23505' }, { code: '23514' }, new Error('programming bug'), null])
    expect(isTransientDatabaseError(error)).toBe(false);
});
