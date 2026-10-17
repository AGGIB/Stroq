import { describe, expect, it } from 'vitest';
import { confirmSkill } from '../../src/install/skill-confirm.js';
import { inspectTree } from '../../src/install/inspect/index.js';
import type { SkillRecord } from '../../src/install/lock.js';
import type { Terminal } from '../../src/ui/terminal.js';
import { treeOf } from '../helpers/install-tree.js';

describe('skill confirmation output', () => {
  it('makes controls and direction overrides visible in replacement summaries', async () => {
    const tree = treeOf({ 'SKILL.md': '---\nname: demo\n---\n# Demo' });
    const passport = inspectTree(tree, {
      kind: 'skill',
      source: { type: 'dir', label: 'demo' },
      extraBlindSpots: [],
      stroqVersion: 'test',
      rulesId: 'test',
    });
    const previous: SkillRecord = {
      kind: 'skill',
      status: 'confirmed',
      source: 'source\u0085name',
      digest: passport.artifact.digest,
      passport,
      installedTo: '/project/demo',
      root: '/project',
      history: [],
    };
    const after = {
      ...passport,
      lines: [
        ...passport.lines,
        {
          kind: 'net' as const,
          subject: 'evil\u202e.example\u0085',
          basis: 'observed' as const,
          sensitive: true,
          where: [{ file: 'SKILL.md', line: 1 }],
          detector: 'test',
        },
      ],
    };
    let output = '';
    const terminal: Terminal = {
      interactive: true,
      color: false,
      color256: false,
      unicode: false,
      columns: 80,
      write: (text) => {
        output += text;
      },
      readLine: async () => passport.artifact.digest.slice(0, 12),
    };
    await confirmSkill(terminal, {
      name: 'demo',
      source: '/src/demo',
      target: { path: '/project/\u202edemo' },
      previous,
      restoring: false,
      made: { tree, passport: after },
      material: true,
      oldTree: tree,
    });
    expect(output).not.toMatch(/[\u0085\u202e]/u);
    expect(output).toContain('new passport line: net "evil\\u202e.example\\u0085"');
  });
});
