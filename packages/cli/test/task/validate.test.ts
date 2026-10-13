import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskArgv } from '../../src/task/args.js';
import { taskContract } from '../../src/task/contract.js';
import { canonicalTaskHome, validateTaskPaths } from '../../src/task/validate.js';

const dirs: string[] = [];
const temp = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'stroq-path-check-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const contract = (cwd: string, argv: string[] = []) =>
  taskContract(parseTaskArgv([...argv, '--', 'fix']), {
    cwd,
    taskId: 'path-check',
    now: new Date(),
    policyDigest: 'a'.repeat(64),
  }).body;

describe('task filesystem boundaries', () => {
  it('signs the physical root for a project explicitly reached through an alias', () => {
    const cwd = temp();
    const alias = join(temp(), 'project-alias');
    symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const body = contract(alias, ['--read', 'src/**']);
    expect(cwd).toBe(realpathSync.native(cwd));
    expect(body.projectRoot).toBe(cwd.replaceAll('\\', '/'));
    expect(body.scope.read.allow).toEqual([`${body.projectRoot}/src/**`]);
  });
  it('normalizes an existing directory and rejects parent or absolute escape paths', () => {
    const cwd = temp();
    mkdirSync(join(cwd, 'src'));
    expect(contract(cwd, ['--read', 'src']).scope.read.allow).toEqual([
      `${cwd.replaceAll('\\', '/')}/src/**`,
    ]);
    expect(() => contract(cwd, ['--read', '../outside'])).toThrow('cannot contain ..');
    expect(() => contract(cwd, ['--write', temp()])).toThrow('inside the project');
  });
  it('resolves a new state path through an existing linked ancestor', () => {
    const cwd = temp();
    const target = temp();
    const alias = join(cwd, 'state-alias');
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(canonicalTaskHome(join(alias, 'new-state'))).toBe(join(target, 'new-state'));
  });
  it('rejects existing escaped links while permitting links inside the project', () => {
    const cwd = temp();
    const home = temp();
    const src = join(cwd, 'src');
    mkdirSync(src);
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(src, join(cwd, 'internal'), kind);
    expect(() => validateTaskPaths(contract(cwd), home, false)).not.toThrow();
    symlinkSync(temp(), join(cwd, 'escaped'), kind);
    expect(() => validateTaskPaths(contract(cwd), home, false)).toThrow('link outside');
  });
  it('refuses project metacharacters and write globs the platform cannot enforce', () => {
    const parent = temp();
    const cwd = join(parent, '[project]');
    mkdirSync(cwd);
    expect(() => validateTaskPaths(contract(cwd), temp(), false)).toThrow('metacharacters');
    if (process.platform !== 'darwin') {
      const normal = temp();
      expect(() => validateTaskPaths(contract(normal, ['--write', '*.ts']), temp(), false)).toThrow(
        'literal --write roots',
      );
    }
  });
});
