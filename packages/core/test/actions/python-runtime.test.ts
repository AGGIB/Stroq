import { describe, expect, it } from 'vitest';
import { findPython, type PythonProbe } from './python-runtime.js';

const apple: PythonProbe = () => ({ status: 0, stdout: '/usr/bin/python3\t3.9.6\t1\t1' });

describe('oracle Python runtime selection', () => {
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
