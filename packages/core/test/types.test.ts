import { describe, expect, it } from 'vitest';
import { ACTION_CLASSES } from '../src/types.js';

describe('types', () => {
  it('exposes the nine action classes', () => {
    expect(ACTION_CLASSES).toHaveLength(9);
    expect(ACTION_CLASSES).toContain('shell.network');
  });
});
