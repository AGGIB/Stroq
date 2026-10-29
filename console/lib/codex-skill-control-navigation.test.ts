import { describe, it, expect } from 'vitest';
import {
  codexSkillControlHref,
  parseCodexSkillControlLocation,
} from './codex-skill-control-navigation';
const id = '10000000-0000-4000-8000-000000000001',
  context = 'codex-context-' + 'a'.repeat(64);
describe('Codex saved declaration navigation', () => {
  it('links saved history without requiring a source capture', () => {
    const href = codexSkillControlHref();
    expect(href).toBe('/skills/?codexControls=history');
    expect(parseCodexSkillControlLocation(new URL(href, 'http://local').searchParams)).toEqual({
      open: true,
      invalid: false,
      recordId: null,
      controlContextId: null,
    });
  });
  it('binds retained record links to their exact Codex data-directory context', () => {
    const href = codexSkillControlHref(id, context);
    expect(parseCodexSkillControlLocation(new URL(href, 'http://local').searchParams)).toEqual({
      open: true,
      invalid: false,
      recordId: id,
      controlContextId: context,
    });
  });
  it.each([
    `codexControl=${id}`,
    `codexControl=${id}&context=bad`,
    `codexControl=${id}&context=${context}&context=${context}`,
    `codexControls=history&codexControl=${id}&context=${context}`,
    'codexControls=unknown',
    `codexControls=history&context=${context}`,
  ])('refuses ambiguous or partial links: %s', (query) => {
    expect(parseCodexSkillControlLocation(new URLSearchParams(query))).toEqual({
      open: true,
      invalid: true,
      recordId: null,
      controlContextId: null,
    });
  });
  it('does not interpret unrelated inventory query parameters as a saved change', () => {
    expect(
      parseCodexSkillControlLocation(new URLSearchParams('kind=skill&view=changed&context=other')),
    ).toEqual({ open: false, invalid: false, recordId: null, controlContextId: null });
  });
  it('uses the history entry for invalid programmatic identities', () => {
    expect(codexSkillControlHref('invalid', context)).toBe('/skills/?codexControls=history');
    expect(codexSkillControlHref(id)).toBe('/skills/?codexControls=history');
  });
});
