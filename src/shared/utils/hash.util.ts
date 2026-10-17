import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

// Sort object keys before hashing so JSON property order does not change the result.
// Callers validate business data and normalize money before passing it here.
export function canonicalHash(data: object): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(data)))
    .digest('hex');
}
