import type { PrefilterTable } from './prefilter.js';

const isLiterals = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((literal) => typeof literal === 'string' && literal !== '');

/**
 * `value` as a `PrefilterTable` if it is one, otherwise null: rule id to, per condition, a list of
 * literals or null. Checked by hand. A schema read the same 2,400 entries in about as long as the
 * table saves in a hook call, and the table is read twice (when the bundle is cut and when it is
 * parsed).
 */
export function readPrefilterTable(value: unknown): PrefilterTable | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  for (const conditions of Object.values(value)) {
    if (!Array.isArray(conditions)) return null;
    for (const literals of conditions) if (literals !== null && !isLiterals(literals)) return null;
  }
  return value as PrefilterTable;
}
