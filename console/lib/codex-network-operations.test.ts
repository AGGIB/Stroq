import { describe, it, expect } from 'vitest';
import { isLocalOperation } from './local-operations';
describe('Codex network operation destinations', () => {
  it('sends tokens only to the nine exact local endpoints', () => {
    for (const path of [
      'codex-network-guard',
      'codex-network-guard/capture',
      'codex-network-guard/preview',
      'codex-network-guard/apply',
      'codex-network-guard/recheck',
      'codex-network-checks',
      'codex-network-checks/preview',
      'codex-network-checks/start',
      'codex-network-checks/cancel',
    ])
      expect(isLocalOperation('/api/' + path)).toBe(true);
  });
  it('refuses invented execution flags, paths, queries and external destinations', () => {
    for (const path of [
      '/api/codex-network-checks/run',
      '/api/codex-network-checks/start/extra',
      '/api/codex-network-guard/capture?path=/tmp',
      'https://foreign.invalid/api/codex-network-guard',
      '/api/codex-network-guard/execute',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
});
