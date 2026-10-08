import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PYTHON_LISTS, judgePythonProgram } from '../../src/actions/inline-python.js';
import { DATA_PROGRAMS, EXEC_PROGRAMS } from './inline-python-corpus.js';

/**
 * The reader (`judgePythonProgram`) says a program only handles data; here the interpreter is
 * asked. Each program the reader calls data is run under an audit hook (PEP 578) with a set of
 * inputs, and the hook refuses and records every event that runs code, starts a process, touches
 * a file, or opens a socket. The lists of names are followed from the modules and values a program
 * can make, along every attribute a program may name, to see whether any path reaches something
 * that runs code. The tests skip where there is no Python 3.8 or later.
 */

const HARNESS = fileURLToPath(new URL('./inline-python-oracle.py', import.meta.url));

function findPython(): string | null {
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(int(sys.version_info >= (3, 8)))'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '1') return name;
  }
  return null;
}

const PYTHON = findPython();
const WORK = PYTHON === null ? '' : mkdtempSync(join(tmpdir(), 'stroq-py-oracle-'));

function ask<T>(request: Record<string, unknown>): T {
  const run = spawnSync(PYTHON as string, [HARNESS], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 120_000,
    cwd: WORK,
    env: { PATH: process.env['PATH'] ?? '', HOME: WORK, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (run.status !== 0) throw new Error(`the harness failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as T;
}

interface RunResult {
  readonly events: readonly (readonly [string, string])[];
  readonly error: string | null;
}

/** What the program is given as its standard input: JSON that talks to the program, text, nothing. */
const STDINS = [
  JSON.stringify({
    a: "__import__('os').system('id')",
    nodes: { x: { location: ['ru', 'Moscow'] } },
    n: 1,
    t: 'x',
    id: 1,
    name: 'n',
    x: '1+1',
    constructor: 2,
    __proto__: 3,
  }),
  JSON.stringify([
    { n: 1, t: 'a', id: 1 },
    { n: 2, t: 'b', id: 2 },
  ]),
  'plain text\nwith lines\nand a number 42\n',
  '',
  '['.repeat(3000) + ']'.repeat(3000),
];

const run = (programs: readonly string[]): RunResult[] =>
  ask<RunResult[]>({ mode: 'run', programs, stdins: STDINS });

describe.skipIf(PYTHON === null)('the interpreter agrees with the reader', () => {
  it('sees what a program that runs code does, so that its silence means something', () => {
    const must = [
      'import sys; exec(sys.stdin.read())',
      'import sys; print(eval(sys.stdin.read()))',
      "__import__('os').system('id')",
      "import os; os.system('id')",
      "import subprocess; subprocess.run(['id'])",
      "import os; os.popen('id').read()",
      "print(open('/etc/hosts').read())",
      'import socket; socket.socket().connect(("127.0.0.1", 9))',
      "open('x', 'w').write('1')",
    ];
    const results = run(must);
    must.forEach((program, i) => {
      expect(results[i]?.events.length, program).toBeGreaterThan(0);
    });
  });

  it('runs no code, process, file or socket in a program the reader calls data', () => {
    const programs = DATA_PROGRAMS.map(([, program]) => program);
    const results = run(programs);
    programs.forEach((program, i) => {
      expect(results[i]?.events, program).toEqual([]);
    });
  });

  it('reads as data nothing that the interpreter sees run code', () => {
    const programs = EXEC_PROGRAMS.map(([, program]) => program);
    programs.forEach((program) => {
      expect(judgePythonProgram(program), program).not.toBe('data');
    });
  });

  it('keeps every builtin the interpreter has out of a program, unless it is on the list', () => {
    const builtins = ask<string[]>({ mode: 'builtins' });
    const allowed = new Set<string>(PYTHON_LISTS.allowedBuiltins);
    const known = new Set<string>(PYTHON_LISTS.knownBuiltins);
    for (const name of builtins) {
      if (
        name.startsWith('_') ||
        ['True', 'False', 'None', 'Ellipsis', 'NotImplemented'].includes(name)
      )
        continue;
      // A program that binds the name in a branch that never runs, and then uses it, is data only
      // when the name is a builtin that cannot run anything.
      const verdict = judgePythonProgram(`if 0:\n    ${name} = 1\nprint(${name})`);
      if (!allowed.has(name))
        expect(verdict, `${name} (known: ${known.has(name)})`).not.toBe('data');
    }
  });

  // A builtin the list does not know would be taken for a variable of the program, which a branch
  // that never runs can bind: a newer Python that adds one makes this fail, and the list is amended.
  it('knows every builtin of this interpreter', () => {
    const builtins = ask<string[]>({ mode: 'builtins' });
    const known = new Set<string>(PYTHON_LISTS.knownBuiltins);
    expect(builtins.filter((name) => !name.startsWith('_') && !known.has(name))).toEqual([]);
  });

  it('reaches nothing that runs code along the names a program may use', () => {
    const paths = ask<string[]>({
      mode: 'reach',
      attributes: PYTHON_LISTS.attributes,
      builtins: PYTHON_LISTS.allowedBuiltins,
      modules: [...PYTHON_LISTS.moduleNames, 'urllib.parse'].filter((m) => m !== 'urllib'),
    });
    expect(paths).toEqual([]);
  });
});

describe.skipIf(PYTHON === null)(
  'programs made from the names on the lists and some that are not',
  () => {
    /** A small seeded generator, so that a failure can be run again. */
    function rng(seed: number): () => number {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const SAFE_IMPORTS = [
      'import json,sys',
      'import re',
      'import sys',
      'import time',
      'import math',
      'import datetime',
      'import collections',
      'import itertools',
      'import csv',
      'import hashlib',
      'import urllib.parse',
      'from json import loads as L',
      'from collections import Counter',
      'from datetime import datetime, timedelta',
    ];
    const UNSAFE_IMPORTS = [
      'import os',
      'import subprocess',
      'import socket',
      'import importlib',
      'import ctypes',
      'import urllib.request',
      'import io',
      'import shutil',
      'import pathlib',
      'import tempfile',
      'import codecs',
      'import operator',
      'import functools',
      'import builtins',
      'import types',
      'import platform',
      'import glob',
      'import base64',
      'import pickle',
      'import marshal',
      'import sqlite3',
      'import threading',
      'from os import system',
      'from sys import modules',
    ];
    const SAFE_EXPRESSIONS = [
      'json.loads(sys.stdin.read() or "{}")',
      'sys.stdin.read()',
      'len(sys.argv)',
      'sys.stdout.write("x")',
      're.sub(r"a", "b", "abc")',
      're.compile("a").findall("aaa")',
      'time.time()',
      'math.sqrt(4)',
      'datetime.datetime.now().isoformat()',
      'collections.Counter("aab").most_common(1)',
      'list(itertools.chain([1], [2]))',
      'hashlib.sha256(b"a").hexdigest()',
      'urllib.parse.quote("a b")',
      'sorted({3: 1, 1: 2}.items())',
      '[a * 2 for a in range(3)]',
      '{k: v for k, v in zip("ab", "cd")}',
      '(lambda q: q + 1)(1)',
      '"x".join(["a", "b"]).upper()',
      'str(1) + repr("a")',
      'iter([1])',
      'next(iter([1]))',
      'isinstance(1, int)',
      'print',
      'bytes(3)',
      'sum(x for x in range(4))',
      'dict(a=1).get("a")',
      '"{0:>4}".format(1)',
      '"%s-%d" % ("a", 2)',
      'sys.version_info[0]',
      'abs(-1) + round(2.5)',
    ];
    const UNSAFE_EXPRESSIONS = [
      'open("/etc/hosts").read()',
      'open("out.txt", "w").write("x")',
      'exec("1")',
      'eval("1")',
      'compile("1", "x", "eval")',
      '__import__("os").system("id")',
      'getattr(sys, "exit")',
      'sys.modules',
      'sys.path',
      'globals()',
      'vars()',
      'dir(sys)',
      'type(1)',
      '(1).__class__',
      '().__class__.__mro__',
      'input()',
      'os.system("id")',
      'os.getcwd()',
      'os.listdir(".")',
      'os.environ["HOME"]',
      'subprocess.run(["id"])',
      'socket.socket()',
      'importlib.import_module("os")',
      'ctypes.CDLL(None)',
      'urllib.request.urlopen("http://127.0.0.1:9")',
      'shutil.rmtree("x")',
      'pathlib.Path(".").iterdir()',
      'tempfile.mkdtemp()',
      'codecs.open("x", "w")',
      'operator.attrgetter("system")(os)',
      'builtins.exec("1")',
      'types.FunctionType',
      'pickle.loads(b"")',
      'glob.glob("*")',
      'system("id")',
      'modules',
      'breakpoint()',
      'help()',
      'memoryview(b"a")',
      'sys.stdin.buffer',
      'sys.stdout = sys.stderr',
      'time.sleep(0)',
      'datetime.datetime.now().tzinfo',
      're.compile("a").scanner',
      'json.decoder',
      'collections.abc',
      'str.__subclasses__()',
    ];

    type Made = { readonly program: string; readonly unsafe: boolean };

    function wrap(next: () => number, expression: string): string {
      switch (Math.floor(next() * 5)) {
        case 0:
          return `print(${expression})`;
        case 1:
          return `x = ${expression}`;
        case 2:
          return `for item in [1, 2]:\n    print(${expression})`;
        case 3:
          return `try:\n    print(${expression})\nexcept Exception as e:\n    print(e)`;
        default:
          return `print(f"{${expression.replace(/"/g, "'")}}")`;
      }
    }

    /** Programs of safe parts, and programs of safe parts with one that is not among them. */
    function programs(seed: number, count: number): Made[] {
      const next = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      const out: Made[] = [];
      for (let n = 0; n < count; n += 1) {
        const unsafe = next() < 0.5;
        const lines: string[] = [];
        for (let i = 0, k = 1 + Math.floor(next() * 3); i < k; i += 1)
          lines.push(pick(SAFE_IMPORTS));
        for (let i = 0, k = 1 + Math.floor(next() * 3); i < k; i += 1)
          lines.push(wrap(next, pick(SAFE_EXPRESSIONS)));
        if (unsafe) {
          const where = Math.floor(next() * (lines.length + 1));
          const part = next() < 0.3 ? pick(UNSAFE_IMPORTS) : wrap(next, pick(UNSAFE_EXPRESSIONS));
          lines.splice(where, 0, part);
        }
        out.push({ program: lines.join('\n'), unsafe });
      }
      return out;
    }

    it('runs no code, process, file or socket in any that the reader calls data', () => {
      const made = programs(20261006, 800);
      const data = made.filter((m) => judgePythonProgram(m.program) === 'data');
      const results = run(data.map((m) => m.program));
      data.forEach((m, i) => {
        expect(results[i]?.events, m.program).toEqual([]);
      });
    });

    it('reads a program of safe parts as data, most of the time, so that the test says something', () => {
      const made = programs(1, 400).filter((m) => !m.unsafe);
      const data = made.filter((m) => judgePythonProgram(m.program) === 'data');
      expect(data.length / made.length).toBeGreaterThan(0.7);
    });

    it('does not read as data a program in which the interpreter sees something run', () => {
      const made = programs(7, 800);
      const results = run(made.map((m) => m.program));
      made.forEach((m, i) => {
        const events = results[i]?.events ?? [];
        if (events.length > 0) expect(judgePythonProgram(m.program), m.program).not.toBe('data');
      });
    });

    it('does not read as data a program that holds a part that is not safe', () => {
      const made = programs(99, 800).filter((m) => m.unsafe);
      const data = made.filter((m) => judgePythonProgram(m.program) === 'data');
      // Some parts are safe to run though they are not on the list (`time.sleep(0)`): the list is
      // what it is. What matters is that none runs anything, which the first test asks of them.
      expect(data.length / made.length).toBeLessThan(0.12);
    });
  },
);
