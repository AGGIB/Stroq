import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_HARDENING,
  formatInspect,
  hardeningExports,
  runInspect,
} from '../../src/commands/inspect.js';
import { repoSurface } from '../../src/exposure/repo-surface.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd } });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '.');
  return dir;
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

describe('stroq inspect', () => {
  it('passes a repository that runs nothing before you approve it', () => {
    const dir = repo();
    const out = capture();
    const code = runInspect([dir]);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('Nothing here runs before you approve it');
  });

  it('fails on a repository that runs a command during an ordinary read', () => {
    const dir = repo();
    git(dir, 'config', 'core.fsmonitor', '/tmp/pwn.sh');
    const out = capture();
    const code = runInspect([dir]);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('core.fsmonitor');
  });

  // The on-open group must never fail the command: a check that fails on every
  // repository with a pre-commit hook is one people stop running.
  it('lists ordinary on-open execution without failing', () => {
    const dir = repo();
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, '.husky', 'pre-commit'), 'pnpm test\n');
    const out = capture();
    const code = runInspect([dir]);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('.husky/pre-commit');
  });

  it('says so plainly when the directory is not a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-plain-'));
    dirs.push(dir);
    expect(formatInspect(dir, repoSurface(dir))).toContain('not a git repository');
  });

  it('reports a missing directory rather than pretending it is clean', () => {
    const out = capture();
    const code = runInspect([join(tmpdir(), 'stroq-inspect-does-not-exist')]);
    out.restore();
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('no such directory');
  });

  it('emits a machine-readable record with --json', () => {
    const dir = repo();
    git(dir, 'config', 'core.fsmonitor', '/tmp/pwn.sh');
    const out = capture();
    runInspect([dir, '--json']);
    out.restore();
    const record = JSON.parse(out.lines.join('')) as { findings: unknown[]; isRepo: boolean };
    expect(record.isRepo).toBe(true);
    expect(record.findings).toHaveLength(1);
  });
});

describe('the git settings stroq inspect --env prints', () => {
  it('declares one key per pair and counts them', () => {
    const text = hardeningExports();
    expect(text).toContain(`export GIT_CONFIG_COUNT=${GIT_HARDENING.length}`);
    GIT_HARDENING.forEach(({ key, value }, i) => {
      expect(text).toContain(`export GIT_CONFIG_KEY_${i}=${key}`);
      expect(text).toContain(`export GIT_CONFIG_VALUE_${i}=${value}`);
    });
  });

  // The claim the command makes, run against real git rather than asserted in a
  // comment. Without the override the repository's own script runs during a plain
  // `git status`; with it, it does not run at all.
  it('stops a repository fsmonitor from running during git status', () => {
    const dir = repo();
    const marker = join(dir, 'marker.txt');
    const script = join(dir, 'fsmonitor.sh');
    writeFileSync(script, `#!/bin/sh\necho fired >> ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    git(dir, 'config', 'core.fsmonitor', script);
    writeFileSync(join(dir, 'a.txt'), 'x\n');

    git(dir, 'status', '--porcelain');
    expect(existsSync(marker), 'the unprotected run should have fired it').toBe(true);
    const firedWithout = readFileSync(marker, 'utf8').trim().split('\n').length;
    expect(firedWithout).toBeGreaterThan(0);
    rmSync(marker);

    const env: Record<string, string> = { ...process.env, HOME: dir } as Record<string, string>;
    env['GIT_CONFIG_COUNT'] = String(GIT_HARDENING.length);
    GIT_HARDENING.forEach(({ key, value }, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env });
    expect(existsSync(marker), 'the protected run must not fire it').toBe(false);
  });
});
