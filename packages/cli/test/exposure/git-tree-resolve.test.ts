import { describe, expect, it } from 'vitest';
import {
  GITLINK,
  MAX_LINK_HOPS,
  SYMLINK,
  createTreeResolver,
  resolve,
  type TreeView,
} from '../../src/exposure/git-tree.js';
import type { TreeEntry } from '../../src/exposure/git-read.js';

const entry = (mode = '100644'): TreeEntry => ({
  mode,
  oid: 'a'.repeat(40),
  size: mode === '100644' ? 0 : -1,
});
const viewOf = (
  entries: readonly (readonly [string, TreeEntry])[],
  targets: readonly (readonly [string, string])[] = [],
): TreeView => ({
  tree: new Map(entries),
  sorted: entries.map(([path]) => path).sort(),
  targets: new Map(targets),
});

class MeasuredMap extends Map<string, TreeEntry> {
  hashedCharacters = 0;
  override get(path: string): TreeEntry | undefined {
    this.hashedCharacters += path.length;
    return super.get(path);
  }
}

describe.each([
  ['single lookup', resolve],
  ['operation index', (path: string, view: TreeView) => createTreeResolver(view)(path)],
] as const)('Git tree resolution: %s', (_name, lookup) => {
  it('does not hash every growing prefix of a deep absent path in a nonempty tree', () => {
    const path = `${'folder/'.repeat(2048)}absent`;
    const tree = new MeasuredMap([['unrelated', entry()]]);
    expect(lookup(path, { tree, sorted: ['unrelated'], targets: new Map() })).toEqual({
      kind: 'none',
    });
    expect(tree.hashedCharacters).toBeLessThan(path.length * 8);
  });

  it('finds a deep ancestor link and preserves the full remaining suffix', () => {
    const parent = Array.from({ length: 80 }, (_, index) => `d${index}`).join('/');
    const target = `${'leaf/'.repeat(80)}file`;
    const view = viewOf(
      [
        [parent, entry(SYMLINK)],
        [`real/${target}`, entry()],
      ],
      [[parent, '/outside']],
    );
    expect(lookup(`${parent}/${target}`, view)).toEqual({
      kind: 'outside',
      target: '/outside',
      links: [parent],
    });
    const inside = viewOf(
      [
        [parent, entry(SYMLINK)],
        [`real/${target}`, entry()],
      ],
      [[parent, `${'../'.repeat(79)}real`]],
    );
    expect(lookup(`${parent}/${target}`, inside)).toEqual({
      kind: 'blob',
      path: `real/${target}`,
      links: [parent],
    });
  });

  it('keeps earliest stop, unread target and submodule precedence', () => {
    const path = `${'part/'.repeat(80)}file`;
    const first = 'part/part';
    const next = `${first}/part/part`;
    expect(
      lookup(
        path,
        viewOf([
          [first, entry(SYMLINK)],
          [next, entry(GITLINK)],
        ]),
      ),
    ).toEqual({ kind: 'unread', link: first, links: [first] });
    expect(
      lookup(
        path,
        viewOf([
          [first, entry(GITLINK)],
          [next, entry(SYMLINK)],
        ]),
      ),
    ).toEqual({ kind: 'submodule', path: first, oid: 'a'.repeat(40), links: [] });
  });

  it('preserves missing and cyclic link outcomes and the exact hop limit', () => {
    expect(lookup('link/file', viewOf([['link', entry(SYMLINK)]], [['link', 'missing']]))).toEqual({
      kind: 'dangling',
      link: 'link',
      missing: 'missing/file',
      links: ['link'],
    });
    const cyclic = lookup('link/file', viewOf([['link', entry(SYMLINK)]], [['link', 'link']]));
    expect(cyclic.kind).toBe('dangling');
    if (cyclic.kind === 'dangling') {
      expect(cyclic.missing).toBeUndefined();
      expect(cyclic.links).toHaveLength(MAX_LINK_HOPS + 1);
    }
  });
});

describe('operation resolver ownership', () => {
  it('uses fresh stop indexes between operations and reads target updates within one fixed tree', () => {
    const tree = new Map<string, TreeEntry>([
      ['link', entry(SYMLINK)],
      ['first/file', entry()],
      ['second/file', entry()],
    ]);
    const targets = new Map([['link', 'first']]);
    const view: TreeView = { tree, sorted: [...tree.keys()].sort(), targets };
    const lookup = createTreeResolver(view);
    expect(lookup('link/file')).toEqual({ kind: 'blob', path: 'first/file', links: ['link'] });
    targets.set('link', 'second');
    expect(lookup('link/file')).toEqual({ kind: 'blob', path: 'second/file', links: ['link'] });
    // This is a new operation: no stale index may remain on the mutable source map.
    tree.set('link', entry(GITLINK));
    expect(createTreeResolver(view)('link/file')).toEqual({
      kind: 'submodule',
      path: 'link',
      oid: 'a'.repeat(40),
      links: [],
    });
    expect(resolve(`${'part/'.repeat(80)}file`, { tree, sorted: view.sorted, targets })).toEqual({
      kind: 'none',
    });
    tree.set('part/part', entry(GITLINK));
    expect(resolve(`${'part/'.repeat(80)}file`, { tree, sorted: view.sorted, targets })).toEqual({
      kind: 'submodule',
      path: 'part/part',
      oid: 'a'.repeat(40),
      links: [],
    });
  });
});
