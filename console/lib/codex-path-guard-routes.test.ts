import { it, expect } from 'vitest';
import { isLocalOperation } from './local-operations';
it('admits exactly the five credential-path routes before sending a local token', () => {
  for (const suffix of ['', '/capture', '/preview', '/apply', '/recheck'])
    expect(isLocalOperation('/api/codex-path-guard' + suffix)).toBe(true);
});
it('rejects file selectors, URL aliases and unimplemented path checks', () => {
  for (const path of [
    '/api/codex-path-guard/',
    '/api/codex-path-guard/preview/extra',
    '/api/codex-path-guard?path=/private/credential',
    '/api/codex-path-guard/apply#token',
    '/api/codex-path-guard-evil',
    '/api/codex-path-guard/../apply',
    '/api/codex-path-guard/check',
    '/api/codex-path-guard/restore',
    'https://foreign.invalid/api/codex-path-guard',
    '//foreign.invalid/api/codex-path-guard',
  ])
    expect(isLocalOperation(path), path).toBe(false);
});
