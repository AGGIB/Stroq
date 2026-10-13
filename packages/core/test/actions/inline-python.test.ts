import { describe, expect, it } from 'vitest';
import { judgePythonProgram } from '../../src/actions/inline-python.js';
import { DATA_PROGRAMS, EXEC_PROGRAMS, UNKNOWN_PROGRAMS } from './inline-python-corpus.js';

/**
 * `curl … | python3 -c '…'` reads a JSON answer, or runs what was fetched, and the pipe cannot say
 * which. The program can: `data` only when every name in it is one that cannot run anything.
 */

describe('programs that only handle data', () => {
  it.each(DATA_PROGRAMS)('%s', (_name, program) => {
    expect(judgePythonProgram(program)).toBe('data');
  });
});

describe('programs that run code', () => {
  it.each(EXEC_PROGRAMS)('%s', (_name, program) => {
    expect(judgePythonProgram(program)).toBe('exec');
  });
});

describe('programs that cannot be told', () => {
  it.each(UNKNOWN_PROGRAMS)('%s', (_name, program) => {
    expect(['unknown', 'exec']).toContain(judgePythonProgram(program));
  });

  it.each([
    ['os for the environment', "import os\nprint(os.environ['HOME'])"],
    ['open', "print(open('/etc/hosts').read())"],
    ['a name nobody defined', 'print(undefined_name)'],
    ['a carriage return', 'print(1)\rexec(x)'],
    ['an unterminated string', "print('abc"],
  ])('is unknown, not exec, when it only cannot be read: %s', (_name, program) => {
    expect(judgePythonProgram(program)).toBe('unknown');
  });
});

describe('an f-string field is a program', () => {
  it('is read as one', () => {
    expect(judgePythonProgram("import sys\nprint(f'{sys.argv}')")).toBe('data');
    expect(judgePythonProgram('print(f\'{__import__("os")}\')')).not.toBe('data');
    expect(judgePythonProgram("print(f'{(lambda: exec)()}')")).toBe('exec');
  });

  it('keeps a doubled brace as text', () => {
    expect(judgePythonProgram("print(f'{{exec(1)}}')")).toBe('data');
  });

  it('keeps \\N{…} as an escape', () => {
    expect(judgePythonProgram("print(f'\\N{LATIN SMALL LETTER A} {1}')")).toBe('data');
  });

  it('is read in a raw string as well', () => {
    expect(judgePythonProgram("print(rf'\\d{exec(1)}')")).toBe('exec');
    expect(judgePythonProgram("print(rf'\\d{1}')")).toBe('data');
  });
});

describe('what a name is', () => {
  it('lets a program use the name it made', () => {
    expect(judgePythonProgram('x = 1\nprint(x)')).toBe('data');
    expect(judgePythonProgram('a, (b, c) = 1, (2, 3)\nprint(a, b, c)')).toBe('data');
    expect(judgePythonProgram('print([y for y in range(3)])')).toBe('data');
    expect(judgePythonProgram('print(sorted([3, 1], key=lambda q: -q))')).toBe('data');
  });

  it('does not let a program make a builtin its own to hide it', () => {
    expect(judgePythonProgram('if 0:\n    open = 1\nprint(open("/etc/hosts").read())')).toBe(
      'unknown',
    );
    expect(judgePythonProgram('if 0:\n    exec = 1\nexec(1)')).toBe('exec');
  });

  it('reads a dotted import as the module it names', () => {
    expect(judgePythonProgram('import urllib.request')).toBe('unknown');
    expect(judgePythonProgram('import os.path')).toBe('unknown');
    expect(judgePythonProgram('import subprocess')).toBe('exec');
  });
});

describe('what the reader is asked to read', () => {
  it('does not take long to read the worst it is given', () => {
    const lines = ['for for for for for for ', 'lambda '.repeat(2000), '(((((('.repeat(2000)];
    for (const program of lines) {
      const start = process.cpuUsage();
      judgePythonProgram(program.slice(0, 16_000));
      const used = process.cpuUsage(start);
      expect((used.user + used.system) / 1000).toBeLessThan(2_000);
    }
  });
});
