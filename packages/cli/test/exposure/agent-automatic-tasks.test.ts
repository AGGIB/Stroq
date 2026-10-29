import { describe, expect, it } from 'vitest';
import { scanFile } from '../../src/exposure/agent-surface.js';
import { describe as describeHit, plainQuote } from '../../src/exposure/agent-report.js';

const hits = (path: string, value: unknown) =>
  scanFile(path, JSON.stringify(value)).filter((hit) => hit.kind === 'editor-autorun-task');
const task = (runOn: string) => ({
  label: 'same label',
  type: 'shell',
  command: 'echo inert',
  dependsOn: 'manual',
  osx: { command: 'echo mac' },
  runOptions: { runOn },
});

describe('released VS Code automatic task triggers', () => {
  it.each(['folderOpen', 'FOLDEROPEN', 'worktreeCreated', 'WORKTREECREATED'])(
    'captures %s in folder and workspace task sources',
    (runOn) => {
      const tasks = [task(runOn), { label: 'manual', command: 'echo dependency' }];
      for (const [path, value] of [
        ['.vscode/tasks.json', { version: '2.0.0', tasks }],
        ['dev.code-workspace', { tasks: { version: '2.0.0', tasks } }],
      ] as const) {
        const found = hits(path, value);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ name: 'same label', severity: 'error' });
        expect(found[0]!.value).toContain('then manual: echo dependency');
        expect(found[0]!.value).toContain('osx: echo mac');
      }
    },
  );

  it('retains eight mixed same-name automatic copies and leaves manual/unknown triggers out', () => {
    const found = hits('.vscode/tasks.json', {
      tasks: [
        ...Array.from({ length: 8 }, (_, index) =>
          task(index % 2 ? 'worktreeCreated' : 'folderOpen'),
        ),
        task('default'),
        task('onSave'),
        { label: 'manual', command: 'echo dependency' },
      ],
    });
    expect(found).toHaveLength(8);
    expect(found.filter((hit) => hit.value.endsWith(' | runOn: worktreeCreated'))).toHaveLength(4);
  });

  it('a trigger transition changes evidence even when label and command stay the same', () => {
    const open = hits('.vscode/tasks.json', { tasks: [task('folderOpen')] })[0];
    const created = hits('.vscode/tasks.json', { tasks: [task('worktreeCreated')] })[0];
    expect(created).toBeDefined();
    expect(created!.value).not.toBe(open!.value);
    expect(describeHit({ ...created!, status: 'present' }, plainQuote)).toContain(
      'configured to run automatically',
    );
  });
});
