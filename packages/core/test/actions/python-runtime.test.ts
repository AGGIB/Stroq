import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { findPython, type PythonProbe } from './python-runtime.js';

const apple: PythonProbe = () => ({ status: 0, stdout: '/usr/bin/python3\t3.9.6\t1\t1' });
const system =
  process.platform === 'darwin'
    ? spawnSync('/usr/bin/python3', ['-c', 'import sys; print(sys.version.split()[0])'], {
        encoding: 'utf8',
        timeout: 5000,
      })
    : null;
const actualApple396 = system?.status === 0 && system.stdout.trim() === '3.9.6';
if (process.platform === 'darwin')
  console.info(
    `[oracle system runtime] /usr/bin/python3: ${system?.stdout?.trim() || 'unavailable'}; Apple 3.9.6 check ${actualApple396 ? 'RUN' : 'SKIPPED (exact runtime unavailable)'}`,
  );

describe('oracle Python runtime selection', () => {
  it.skipIf(!actualApple396)(
    'rejects the actual Apple Python 3.9.6 executable before semantic checks',
    () => {
      expect(() => findPython('/usr/bin/python3')).toThrow(
        /Apple Python 3.9.6.*No semantic checks/,
      );
    },
  );
  it('rejects Apple Python 3.9.6 before any semantic assertion', () => {
    expect(() => findPython('/usr/bin/python3', apple, 'darwin')).toThrow(
      /Apple Python 3.9.6.*Install CPython 3.12.*No semantic checks/,
    );
  });
  it('selects standard CPython after an unsupported Apple interpreter', () => {
    const probe: PythonProbe = (name) =>
      name === 'python3' ? apple(name) : { status: 0, stdout: '/opt/python3.12\t3.12.14\t1\t0' };
    expect(findPython(undefined, probe, 'darwin')).toEqual({
      path: '/opt/python3.12',
      version: '3.12.14',
      isApple: false,
    });
  });
  it('fails clearly rather than skipping when only Apple Python is available', () => {
    expect(() => findPython(undefined, apple, 'darwin')).toThrow(/Apple Python 3.9.6/);
  });
  it('reports invalid explicit choices and old interpreters', () => {
    expect(() => findPython('missing', () => ({ status: 1, stderr: 'not found' }))).toThrow(
      /could not be executed/,
    );
    expect(() => findPython('old', () => ({ status: 0, stdout: '/old\t3.7.0\t0\t0' }))).toThrow(
      /Python >=3.8/,
    );
  });
});
