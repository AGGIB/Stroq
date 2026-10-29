import { it, expect } from 'vitest';
import { codexPathGuardLocation, codexPathGuardHref } from './codex-path-guard-navigation';
const context = 'codex-context-' + 'a'.repeat(64),
  recordId = '00000000-0000-4000-8000-000000000001';
it('builds namespaced retained links independent from network filters', () => {
  const href = codexPathGuardHref({ controlContextId: context, recordId });
  expect(href).toContain('codexPaths=history');
  const q = new URL(href, 'http://fixture').searchParams;
  q.set('codexNetwork', 'history');
  q.set('record', 'private-other-feature');
  expect(codexPathGuardLocation(q)).toEqual({
    open: true,
    invalid: false,
    view: 'history',
    controlContextId: context,
    recordId,
  });
});
it('refuses duplicate malformed and unbound exact destinations', () => {
  for (const q of [
    'codexPaths=history&pathRecord=' + recordId,
    'codexPaths=paths&pathContext=' + context + '&pathRecord=' + recordId,
    'codexPaths=history&pathContext=' + context + '&pathContext=' + context,
    'codexPaths=history&pathContext=/private/path',
    'codexPaths=history&pathRecord=bad',
  ])
    expect(codexPathGuardLocation(new URLSearchParams(q)).invalid).toBe(true);
});
it('does not open absent feature query and supports saved history without a source', () => {
  expect(codexPathGuardLocation(new URLSearchParams('codexNetwork=default')).open).toBe(false);
  expect(codexPathGuardHref()).toBe('/agents/?codexPaths=paths');
  expect(codexPathGuardHref({ view: 'history' })).toBe('/agents/?codexPaths=history');
});
