import { describe, expect, it } from 'vitest';
import { ACTION_CLASSES } from '../src/types.js';

describe('types', () => {
  it('exposes the twelve action classes', () => {
    expect(ACTION_CLASSES).toHaveLength(12);
    expect(ACTION_CLASSES).toContain('shell.network');
    expect(ACTION_CLASSES).toContain('config.self_touch');
    expect(ACTION_CLASSES).toContain('origin.untrusted');
    expect(ACTION_CLASSES).toContain('origin.suspect');
  });
});
