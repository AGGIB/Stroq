import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTrust } from '../../src/commands/trust.js';
import { checkFolder } from '../../src/folder-check.js';
import { trustedFoldersFile } from '../../src/paths.js';

// Fixtures are read and never run; nothing here runs a project.
const FETCHED =
  'function getCookie() {\n  fetch(u).then((r) => r.text()).then((t) => eval(t));\n}\n';

const dirs: string[] = [];
let home: string;

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-trust-folder-')));
  dirs.push(dir);
  return dir;
}

function folder(files: Readonly<Record<string, string>>): string {
  const dir = temp();
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: { ...process.env, HOME: dir } });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function trust(...argv: string[]): { code: number; out: string } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const code = runTrust(argv);
  spy.mockRestore();
  return { code, out };
}

const ask = (cwd: string, sessionId: string) =>
  checkFolder({ sessionId, command: 'npm test', cwd }, { home, userHome: temp() });

beforeEach(() => {
  home = temp();
  process.env['STROQ_HOME'] = home;
});
afterEach(() => {
  delete process.env['STROQ_HOME'];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stroq trust --folder', () => {
  it('stops the question for what the folder holds now', async () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    expect((await ask(dir, 's1'))?.reason).toContain('stroq trust --folder');
    const run = trust('--folder', dir);
    expect(run.code).toBe(0);
    expect(run.out).toContain(dir);
    expect(run.out).toContain('src/auth.js:2');
    expect(await ask(dir, 's2')).toBeNull();
  });

  it('does not cover what is added later', async () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    trust('--folder', dir);
    writeFileSync(join(dir, 'src/more.js'), FETCHED);
    expect((await ask(dir, 's2'))?.reason).toContain('src/more.js:2');
  });

  it('does not cover another folder with the same files', async () => {
    trust('--folder', folder({ 'src/auth.js': FETCHED }));
    expect(await ask(folder({ 'src/auth.js': FETCHED }), 's2')).not.toBeNull();
  });

  it('a subfolder trusts the repository it is in', async () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    trust('--folder', join(dir, 'src'));
    expect(await ask(dir, 's2')).toBeNull();
  });

  it('says so when there is nothing to trust, and writes nothing', () => {
    const run = trust('--folder', folder({ 'a.js': 'run();\n' }));
    expect(run.code).toBe(0);
    expect(run.out).toContain('nothing to trust');
    expect(() => statSync(trustedFoldersFile())).toThrow();
  });

  it('a folder that is not there is an error', () => {
    const run = trust('--folder', join(temp(), 'gone'));
    expect(run.code).toBe(1);
  });

  it('is listed, and can be taken back', async () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    trust('--folder', dir);
    expect(trust('--list').out).toContain(dir);
    expect(trust('--remove', dir).code).toBe(0);
    expect(trust('--list').out).not.toContain(dir);
    expect(await ask(dir, 's2')).not.toBeNull();
  });

  it.skipIf(process.platform === 'win32')('keeps its record private', () => {
    trust('--folder', folder({ 'src/auth.js': FETCHED }));
    expect(statSync(trustedFoldersFile()).mode & 0o777).toBe(0o600);
  });

  it('a record it cannot read trusts nothing', async () => {
    const dir = folder({ 'src/auth.js': FETCHED });
    trust('--folder', dir);
    writeFileSync(trustedFoldersFile(), 'not json');
    expect(await ask(dir, 's2')).not.toBeNull();
  });
});
