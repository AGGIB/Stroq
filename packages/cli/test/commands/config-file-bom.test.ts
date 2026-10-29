import { describe, expect, it } from 'vitest';
import { parseConfigJson } from '../../src/commands/config-file.js';

describe('JSON config byte-order mark', () => {
  it('accepts one leading UTF-8 BOM and retains embedded string content', () => {
    expect(
      parseConfigJson('settings.json', '\ufeff{\r\n  "foreign": "inside\ufeffvalue"\r\n}\r\n'),
    ).toEqual({ foreign: 'inside\ufeffvalue' });
  });
  it('does not strip internal or repeated BOM syntax or expose input in errors', () => {
    for (const text of [
      '\ufeff\ufeff{"PRIVATE_SETTINGS":true}',
      '{\ufeff"PRIVATE_SETTINGS":true}',
    ]) {
      expect(() => parseConfigJson('settings.json', text)).toThrow(/cannot parse settings\.json/);
      try {
        parseConfigJson('settings.json', text);
      } catch (error) {
        expect((error as Error).message).not.toContain('PRIVATE_SETTINGS');
      }
    }
  });
});
