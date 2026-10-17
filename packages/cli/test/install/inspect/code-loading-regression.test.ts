import { describe, expect, it } from 'vitest';
import { outsideImportsOfTree } from '../../../src/install/inspect/imports.js';
import { buildTree } from '../../../src/install/tree.js';
import { fileEntry } from '../../helpers/install-tree.js';
import { SHAPES } from './code-loading-shapes.js';

/**
 * The corpus of shapes that an earlier reader flagged (`code-loading-shapes.ts`) against the reading as it is now: the
 * rules that watch identifiers wherever they stand replaced a list of shapes, and must not have lost one of them. A row
 * that fails is named by its group and its text. Rows are only ever added.
 */
const flagged = (text: string): boolean =>
  outsideImportsOfTree(buildTree([fileEntry('server.js', text)], { complete: true })).concerns
    .length > 0;

describe('no shape that an earlier reader flagged is lost', () => {
  it('holds the rows of every group', () => {
    const groups = new Map<string, number>();
    for (const shape of SHAPES) groups.set(shape.group, (groups.get(shape.group) ?? 0) + 1);

    expect([...groups.keys()].sort()).toEqual([
      'the aliasing list',
      'the first reader',
      'the identifiers list',
      'the pattern list',
      'the registry reader',
      'the reviewer probe',
    ]);
    expect(SHAPES.length).toBeGreaterThan(200);
  });

  it.each(SHAPES.map((shape) => [shape.group, shape.text] as const))(
    '%s: %j is still flagged',
    (_group, text) => {
      expect(flagged(text), text).toBe(true);
    },
  );
});
