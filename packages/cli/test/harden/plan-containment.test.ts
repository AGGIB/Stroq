import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTargetText } from '../../src/harden/atomic.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { planTextBlock } from '../../src/harden/textblock.js';
import type { JsonEdit, Plan, PlanOptions } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTempDirs();
});

const onWindows = process.platform === 'win32';
const SECRET = 'stroq_attack_fixture_value_0123456789';

const addDeny: JsonEdit = { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'a' };

/**
 * A planner reads the file in order to show what would change. If it read through a link before
 * asking where the link leads, the preview itself would carry the content of any file the link
 * points at: that is what a diff of the file would be made of. The path is judged first, by the
 * same rules the write is, and a file that fails is never opened.
 */
interface Planners {
  readonly name: string;
  plan(file: string, options: PlanOptions): Plan;
}

const planners: Planners[] = [
  { name: 'planJsonEdits', plan: (file, options) => planJsonEdits(file, [addDeny], options) },
  {
    name: 'planTextBlock',
    plan: (file, options) => planTextBlock(file, { id: 'cursor-ignore', lines: ['.env'] }, options),
  },
];

describe.each(planners)('$name: where the path leads, before it reads', (p) => {
  it('reads a file that is not there yet, in a root, as it always did', () => {
    const project = tempDir('project');
    const read = vi.fn(readTargetText);

    const plan = p.plan(join(project, 'new', 'settings.json'), { read, root: project });

    expect(read).toHaveBeenCalledTimes(1);
    expect(plan.refused).toBeUndefined();
    expect(plan.existed).toBe(false);
  });

  // `init`'s rule asks the working directory, which a test run or a build can have deleted. That is
  // a failure of the machine and reads as one: it is not a plan that was refused.
  it('does not turn a failure of the machine into a refused plan', () => {
    const project = tempDir('project');
    const gone = Object.assign(new Error('ENOENT: no current directory'), { code: 'ENOENT' });
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw gone;
    });
    const read = vi.fn(readTargetText);

    expect(() => p.plan(join(project, 'settings.json'), { read })).toThrow(gone);
    expect(read).not.toHaveBeenCalled();
  });

  describe.skipIf(onWindows)('with links', () => {
    links(p);
  });
});

function links(p: Planners): void {
  /** A project, a victim outside it holding a secret, and a link in the project to the victim. */
  function leadingOut() {
    const dir = tempDir();
    const project = join(dir, 'project');
    const victim = join(dir, 'elsewhere', 'victim.json');
    mkdirSync(project, { recursive: true });
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, `{"token": "${SECRET}"}\n`);
    const link = join(project, 'settings.json');
    symlinkSync(victim, link);
    return { dir, project, victim, link };
  }

  it('refuses a link that leaves the root, without reading it', () => {
    const { project, victim, link } = leadingOut();
    const read = vi.fn(readTargetText);

    const plan = p.plan(link, { read, root: project });

    expect(read).not.toHaveBeenCalled();
    expect(plan.refused).toBe('path-escapes-root');
    expect(plan.real).toBe(victim);
    expect(plan.changed).toBe(false);
    expect(plan.edits).toEqual([]);
  });

  it('puts nothing of the file in the plan, so no diff can show it', () => {
    const { project, link } = leadingOut();

    const plan = p.plan(link, { read: readTargetText, root: project });

    expect(plan.before).toBe('');
    expect(plan.after).toBe('');
    expect(plan.diff).toBe('');
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    expect(readFileSync(link, 'utf8')).toContain(SECRET);
  });

  it('names the place in what it says, and never the value', () => {
    const { project, victim, link } = leadingOut();

    const plan = p.plan(link, { read: readTargetText, root: project });

    expect(plan.refusedDetail).toContain(victim);
    expect(plan.refusedDetail).toContain(project);
    expect(plan.refusedDetail).not.toContain(SECRET);
  });

  it('refuses a link that leaves the tree `init` would write in, when no root is named', () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const project = join(home, 'code', 'repo');
    const victim = join(home, '.config', 'tool.json');
    mkdirSync(project, { recursive: true });
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, `{"token": "${SECRET}"}\n`);
    symlinkSync(victim, join(project, 'settings.json'));
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const read = vi.fn(readTargetText);

    const plan = p.plan(join(project, 'settings.json'), { read });

    expect(read).not.toHaveBeenCalled();
    expect(plan.refused).toBe('path-escapes-root');
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it('refuses when the directory the file is in is the link', () => {
    const { dir, project } = leadingOut();
    const elsewhere = join(dir, 'elsewhere');
    writeFileSync(join(elsewhere, 'hooks.json'), `{"token": "${SECRET}"}\n`);
    symlinkSync(elsewhere, join(project, '.cursor'));
    const read = vi.fn(readTargetText);

    const plan = p.plan(join(project, '.cursor', 'hooks.json'), { read, root: project });

    expect(read).not.toHaveBeenCalled();
    expect(plan.refused).toBe('path-escapes-root');
  });

  it('refuses a link that points nowhere, without reading it', () => {
    const dir = tempDir();
    const project = join(dir, 'project');
    mkdirSync(project);
    symlinkSync(join(dir, 'nowhere', 'file.json'), join(project, 'settings.json'));
    const read = vi.fn(readTargetText);

    const plan = p.plan(join(project, 'settings.json'), { read, root: project });

    expect(read).not.toHaveBeenCalled();
    expect(plan.refused).toBe('dangling-link');
    expect(plan.changed).toBe(false);
  });

  it('still reads a file that is in the root, once, by its real path', () => {
    const dir = tempDir();
    const project = join(dir, 'project');
    const real = join(project, 'dotfiles', 'settings.json');
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, '{}\n');
    symlinkSync(real, join(project, 'settings.json'));
    const read = vi.fn(readTargetText);

    const plan = p.plan(join(project, 'settings.json'), { read, root: project });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(real);
    expect(plan.refused).toBeUndefined();
  });
}
