import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autorunOf } from '../../src/card/autorun.js';
import { mergeCursorHooks } from '../../src/commands/cursor-hooks.js';
import { hookCommand } from '../../src/commands/hook-command.js';

/**
 * A Cursor hook that `stroq init` writes holds more than its command: `failClosed`, and a `matcher` on
 * `preToolUse`. The reading of the folder shows those fields with the command, and the card compared the
 * whole of it with the line, so Stroq's own Cursor hooks were counted as something the folder runs. Only
 * the fields `init` writes, with the values it writes, are taken off; any other field keeps the hook on
 * the card. The files are written by the writer `init` uses, and nothing is run.
 */
let root: string;
let home: string;
let entry: string;
let project: string;
const node = process.execPath;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-own-cursor-')));
  home = join(root, 'stroq-home');
  entry = join(home, 'cli', 'index.js');
  project = join(root, 'project');
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(join(project, '.cursor'), { recursive: true });
  writeFileSync(entry, '// fixture\n');
  vi.stubEnv('STROQ_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const hooksFile = (): string => join(project, '.cursor', 'hooks.json');

describe('a Cursor hook that stroq init wrote', () => {
  it('is not counted as something the folder runs', () => {
    writeFileSync(
      hooksFile(),
      JSON.stringify(mergeCursorHooks({}, hookCommand(node, entry, 'cursor'))),
    );
    expect(autorunOf(project)).toBeNull();
  });

  it('with a field init does not write is counted', () => {
    const written = mergeCursorHooks({}, hookCommand(node, entry, 'cursor'));
    const hooks = written.hooks ?? {};
    const [first] = Object.keys(hooks);
    const changed = {
      ...written,
      hooks: {
        ...hooks,
        [first ?? 'preToolUse']: (hooks[first ?? 'preToolUse'] ?? []).map((entry) => ({
          ...entry,
          env: { NODE_OPTIONS: '--require ./x.js' },
        })),
      },
    };
    writeFileSync(hooksFile(), JSON.stringify(changed));
    expect(autorunOf(project)?.items.length).toBe(1);
  });

  it('with a value init does not write is counted', () => {
    const written = mergeCursorHooks({}, hookCommand(node, entry, 'cursor'));
    const hooks = written.hooks ?? {};
    const changed = {
      ...written,
      hooks: {
        ...hooks,
        preToolUse: (hooks['preToolUse'] ?? []).map((entry) => ({ ...entry, failClosed: false })),
      },
    };
    writeFileSync(hooksFile(), JSON.stringify(changed));
    expect(autorunOf(project)?.items.map((item) => item.name)).toEqual(['preToolUse']);
  });

  it('that runs a file of the folder is counted, whatever its fields', () => {
    const local = join(project, 'index.js');
    writeFileSync(local, '// foreign\n');
    writeFileSync(
      hooksFile(),
      JSON.stringify(mergeCursorHooks({}, hookCommand(node, local, 'cursor'))),
    );
    expect(autorunOf(project)).not.toBeNull();
  });
});
