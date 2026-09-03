import { describe, expect, it } from 'vitest';
import { ACTION_CLASSES } from '../src/types.js';

describe('types', () => {
  it('exposes the ten action classes', () => {
    expect(ACTION_CLASSES).toHaveLength(10);
    expect(ACTION_CLASSES).toContain('shell.network');
    expect(ACTION_CLASSES).toContain('config.self_touch');
  });
});
