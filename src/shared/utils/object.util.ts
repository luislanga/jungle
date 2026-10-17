export function freezeData(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeData(child);
  Object.freeze(value);
}
