import { describe, expect, it } from 'vitest';
import { commandHelp } from '../src/help.js';

describe('MCP call-control command help', () => {
  it('documents the stable UUID, explicit environment and local setup requirement', () => {
    const text = commandHelp('mcp');
    expect(text).toContain('--call-control <uuid>');
    expect(text).toMatch(/--call-control[\s\S]*--pass-env/);
    expect(text).toMatch(/--call-control[\s\S]*local.*setup/i);
  });
});
