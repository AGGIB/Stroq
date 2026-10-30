/** Small closed-schema predicates for the local-only API boundary. */
export function closed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
    Reflect.ownKeys(v).every((k) => typeof k === 'string' && keys.includes(k))
  );
}
export function text(v: unknown, max = 240): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(v)
  );
}
export function member(v: unknown, values: readonly string[]): boolean {
  return typeof v === 'string' && values.includes(v);
}
export function count(v: unknown, max = 100_000): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
}
export function hash(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
}
export function stamp(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))
    return false;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString() === v;
}
export function list<T>(
  v: unknown,
  max: number,
  validator: (item: unknown) => item is T,
): v is T[] {
  return Array.isArray(v) && v.length <= max && v.every(validator);
}
