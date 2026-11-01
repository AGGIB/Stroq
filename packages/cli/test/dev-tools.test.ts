import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtCliEntry, devHelp, devUsageError, runDevTool } from '../src/dev-help.js';
import { REPO_ROOT, devToolArgv } from './helpers/dev-tool.js';

/**
 * `pnpm dev:bench`, `dev:coverage` and `dev:prove` are what `stroq bench`, `coverage` and `prove` were:
 * the same flags, the same output, the same exit codes. What is new is the thin part in front of them, which
 * answers `--help`, an option the tool does not have and the `--` that `pnpm` may pass on, as the CLI did.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs a tool in process with what it printed kept. */
async function ran(name: string, args: readonly string[], run = vi.fn(() => 0)) {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  const code = await runDevTool(name, args, run);
  return { code, out, err, run };
}

describe('runDevTool', () => {
  it('prints the usage of the tool for --help and -h, and runs nothing', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await ran('bench', ['--actions', flag]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(devHelp('bench'));
      expect(r.run).not.toHaveBeenCalled();
    }
  });

  it('names an option the tool does not have, with exit 2, and runs nothing', async () => {
    const r = await ran('coverage', ['--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toBe(devUsageError('coverage', 'unknown option --bogus'));
    expect(r.err).toContain('pnpm dev:coverage -- --help');
    expect(r.run).not.toHaveBeenCalled();
  });

  it('hands the arguments on as they are, and drops the one leading `--` that pnpm passes', async () => {
    const withDashes = await ran('bench', ['--', '--actions', '--json']);
    expect(withDashes.run).toHaveBeenCalledWith(['--actions', '--json']);
    const without = await ran('bench', ['--actions', '--json']);
    expect(without.run).toHaveBeenCalledWith(['--actions', '--json']);
  });

  it('returns the exit code of the tool', async () => {
    const r = await ran(
      'bench',
      ['--actions'],
      vi.fn(() => 1),
    );
    expect(r.code).toBe(1);
  });

  it('answers an argument that parseArgs refuses with exit 2 and the first sentence of why', async () => {
    const refuse = vi.fn(() => {
      throw Object.assign(new Error("Option '--format <value>' argument missing. Try again."), {
        code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      });
    });
    const r = await ran('coverage', ['--format'], refuse);
    expect(r.code).toBe(2);
    expect(r.err).toBe(devUsageError('coverage', "Option '--format <value>' argument missing"));
  });

  it('lets any other failure through', async () => {
    const broken = vi.fn(() => {
      throw new Error('disk full');
    });
    await expect(ran('prove', [], broken)).rejects.toThrow('disk full');
  });

  it('knows the three tools and no other', async () => {
    for (const name of ['prove', 'bench', 'coverage']) expect(devHelp(name)).not.toBeNull();
    expect(devHelp('add')).toBeNull();
    await expect(runDevTool('add', [], () => 0)).rejects.toThrow(/no developer tool/);
  });
});

describe('builtCliEntry', () => {
  it('is the dist/index.js of this package, which the global setup of the tests built', () => {
    const entry = builtCliEntry();
    expect(basename(entry)).toBe('index.js');
    expect(existsSync(entry)).toBe(true);
    expect(entry).toContain(join('packages', 'cli', 'dist'));
  });
});

describe('the scripts, as a process of their own', () => {
  const home = mkdtempSync(join(tmpdir(), 'stroq-dev-tools-'));
  const run = (name: 'bench' | 'coverage' | 'prove', ...args: string[]) =>
    spawnSync(process.execPath, devToolArgv(name, ...args), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: '',
      env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: join(home, '.stroq') },
    });

  it.each(['bench', 'coverage', 'prove'] as const)(
    '%s --help prints its usage and exits 0',
    (name) => {
      const out = run(name, '--help');
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toBe(devHelp(name));
    },
  );

  it('coverage prints the mapping as JSON', () => {
    const out = run('coverage', '--json');
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ version: 1 });
  });

  it('bench --actions --json measures the ordinary work and prints one document', () => {
    const out = run('bench', '--', '--actions', '--json');
    expect([0, 1], out.stderr).toContain(out.status);
    expect(JSON.parse(out.stdout)).toMatchObject({ version: 2 });
  }, 60_000);

  it('refuses an option it does not have with exit 2', () => {
    const out = run('bench', '--nope');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('pnpm dev:bench: unknown option --nope');
  });
});
