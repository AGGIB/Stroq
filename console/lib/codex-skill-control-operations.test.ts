import { describe, expect, it } from 'vitest';
import { isLocalOperation } from './local-operations';

describe('Codex skill controls token destination allowlist', () => {
  it('accepts exactly the four local operations', () => {
    for (const path of [
      'codex-controls',
      'codex-control-preview',
      'codex-control-apply',
      'codex-control-recheck',
    ])
      expect(isLocalOperation('/api/inventory/' + path)).toBe(true);
  });
  it('rejects invented operations, suffixes, query tokens and foreign origins', () => {
    for (const path of [
      '/api/inventory/codex-control-enable',
      '/api/inventory/codex-control-apply/extra',
      '/api/inventory/codex-controls?token=private',
      'https://foreign.invalid/api/inventory/codex-controls',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
});
