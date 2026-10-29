import { describe, expect, it } from 'vitest';
import { inventoryHref, inventorySelection, inventoryViewMatches } from './inventory-navigation';
const id = `item-${'a'.repeat(24)}`,
  workspaceId = `workspace-${'b'.repeat(24)}`,
  sha256 = 'c'.repeat(64);
describe('artifact links bind workspace and captured version', () => {
  it('round trips an exact artifact, project and kind without credentials', () => {
    const href = inventoryHref(id, workspaceId, sha256, 'skill');
    expect(href).toBe(`/skills/?kind=skill&workspace=${workspaceId}&item=${id}&sha=${sha256}`);
    expect(inventorySelection(new URL(href, 'http://localhost').searchParams)).toEqual({
      id,
      workspaceId,
      sha256,
      invalid: false,
      kind: 'skill',
      view: 'all',
    });
  });
  it('keeps missing/unverifiable artifacts addressable without inventing a current digest', () => {
    expect(
      inventorySelection(
        new URL(inventoryHref(id, workspaceId, null), 'http://localhost').searchParams,
      ),
    ).toEqual({ id, workspaceId, sha256: null, invalid: false, kind: 'all', view: 'all' });
  });
  it('refuses identifiers with paths, tokens and incomplete workspace context', () => {
    for (const query of [
      `item=${id}`,
      `item=/private/key&workspace=${workspaceId}`,
      `item=${id}&workspace=${workspaceId}&sha=secret`,
      'item=',
    ])
      expect(inventorySelection(new URLSearchParams(query)).invalid).toBe(true);
    expect(inventoryHref('/private?token=secret', workspaceId, sha256)).toBe('/skills/');
  });
  it('does not copy arbitrary query text, authentication tokens or fragments into canonical links', () => {
    const selection = inventorySelection(
      new URLSearchParams(
        `item=${id}&workspace=${workspaceId}&sha=${sha256}&kind=mcp&token=private&q=private`,
      ),
    );
    expect(
      inventoryHref(selection.id, selection.workspaceId, selection.sha256, selection.kind),
    ).toBe(`/skills/?kind=mcp&workspace=${workspaceId}&item=${id}&sha=${sha256}`);
    expect(inventorySelection(new URLSearchParams('kind=unknown'))).toEqual({
      id: null,
      workspaceId: null,
      sha256: null,
      invalid: false,
      kind: 'all',
      view: 'all',
    });
  });
});

describe('bounded inventory views', () => {
  it('round trips supported views with exact selection and type; unknown query text is discarded', () => {
    for (const view of ['signals', 'changes', 'unreviewed', 'incomplete'] as const) {
      const href = inventoryHref(id, workspaceId, sha256, 'skill', view);
      const selection = inventorySelection(new URL(href, 'http://localhost').searchParams);
      expect(selection).toEqual({ id, workspaceId, sha256, invalid: false, kind: 'skill', view });
      expect(inventoryHref(null, null, null, 'skill', view)).toBe(
        `/skills/?kind=skill&view=${view}`,
      );
    }
    const selection = inventorySelection(new URLSearchParams('view=/private?token=secret'));
    expect(selection.view).toBe('all');
    expect(
      inventoryHref(
        selection.id,
        selection.workspaceId,
        selection.sha256,
        selection.kind,
        selection.view,
      ),
    ).toBe('/skills/');
  });
  it('keeps matched signals independent of reviewed state and incomplete evidence separate', () => {
    const item = { state: 'unchanged' as const, scan: { status: 'suspect' as const, findings: 2 } };
    expect(inventoryViewMatches(item, 'signals')).toBe(true);
    expect(inventoryViewMatches(item, 'changes')).toBe(false);
    expect(inventoryViewMatches(item, 'unreviewed')).toBe(false);
    expect(inventoryViewMatches(item, 'incomplete')).toBe(false);
    expect(inventoryViewMatches({ ...item, state: 'changed' }, 'changes')).toBe(true);
    expect(inventoryViewMatches({ ...item, state: 'missing' }, 'changes')).toBe(true);
    expect(inventoryViewMatches({ ...item, state: 'unreviewed' }, 'unreviewed')).toBe(true);
    expect(inventoryViewMatches({ ...item, state: 'unverifiable' }, 'incomplete')).toBe(true);
    expect(
      inventoryViewMatches({ ...item, scan: { status: 'incomplete', findings: 0 } }, 'incomplete'),
    ).toBe(true);
    expect(
      inventoryViewMatches(
        { state: 'unchanged', scan: { status: 'clean', findings: 2 } },
        'signals',
      ),
    ).toBe(false);
    expect(inventoryViewMatches(item, 'all')).toBe(true);
  });
});
