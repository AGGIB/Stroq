import { describe, expect, it } from 'vitest';
import { readPrefilterTable } from '../../../src/rules/prefilter/table-check.js';

describe('readPrefilterTable', () => {
  it('reads a table of literals and nulls', () => {
    const table = { 'X-1': [['alpha', 'beta'], null], 'X-2': [] };
    expect(readPrefilterTable(table)).toBe(table);
    expect(readPrefilterTable({})).toEqual({});
  });

  it('refuses what is not a table', () => {
    for (const value of [
      undefined,
      null,
      'text',
      7,
      [],
      [['alpha']],
      { 'X-1': 'alpha' },
      { 'X-1': { 0: ['alpha'] } },
      { 'X-1': [['alpha'], 'beta'] },
      { 'X-1': [[]] },
      { 'X-1': [['']] },
      { 'X-1': [[1]] },
      { 'X-1': [undefined] },
    ])
      expect(readPrefilterTable(value), JSON.stringify(value)).toBeNull();
  });
});
