import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readPythonProcesses, type PythonProcess } from '../../src/actions/python-processes.js';
import { findPython } from './python-runtime.js';

/**
 * The reader (`readPythonProcesses`) says what processes a program starts; here the interpreter is
 * asked. Each program is run under an audit hook (PEP 578) that records every process it would start
 * and refuses it before it starts (`inline-python-oracle.py`, mode `spawns`): nothing is run. Where
 * the reader says it read every way the program has to start one, each process the interpreter was
 * asked to start has to be one the reader handed back. The tests skip where there is no Python 3.8
 * or later, and on Windows.
 */

const HARNESS = fileURLToPath(new URL('./inline-python-oracle.py', import.meta.url));
const PYTHON = process.platform === 'win32' ? null : (findPython()?.path ?? null);
const WORK = PYTHON === null ? '' : mkdtempSync(join(tmpdir(), 'stroq-py-spawns-'));

type Spawned =
  | { readonly kind: 'shell'; readonly line: string }
  | { readonly kind: 'argv'; readonly words: readonly string[] }
  | { readonly kind: 'other'; readonly event: string };

function spawned(programs: readonly string[]): (readonly Spawned[])[] {
  const run = spawnSync(PYTHON as string, [HARNESS], {
    input: JSON.stringify({ mode: 'spawns', programs }),
    encoding: 'utf8',
    timeout: 120_000,
    cwd: WORK,
    env: { PATH: process.env['PATH'] ?? '', HOME: WORK, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (run.status !== 0) throw new Error(`the harness failed: ${run.stderr}`);
  return (JSON.parse(run.stdout) as { spawned: Spawned[] }[]).map((r) => r.spawned);
}

/** The words of a command the reader built: its words are plain, or in single quotes (`'it'\''s'`). */
function wordsOf(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (ch === '\\') {
      word = (word ?? '') + command.charAt(i + 1);
      i += 1;
    } else word = (word ?? '') + ch;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Whether a process the interpreter was asked to start is one the reader handed back. */
function readAs(found: Spawned, processes: readonly PythonProcess[]): boolean {
  if (found.kind === 'other') return false;
  return processes.some((process) => {
    if (found.kind === 'shell') return process.command === found.line;
    const words = wordsOf(process.command);
    return words.length === found.words.length && words.every((word, i) => word === found.words[i]);
  });
}

/** Programs whose every process the reader says it read; each process is refused before it starts. */
const READ = [
  "import os\nos.system('echo one')",
  "import os\nprint(os.popen('echo one').read())",
  "import subprocess\nsubprocess.run(['echo', 'a b', \"it's\", '*', '~', ''])",
  "import subprocess\nsubprocess.run('echo one | cat', shell=True)",
  "import subprocess\nsubprocess.call(('echo', 'x'))",
  "import subprocess\nprint(subprocess.getoutput('echo one'))",
  "import subprocess\nsubprocess.check_output(['echo', '--format=%H %s'])",
  "import subprocess\nsubprocess.Popen(['echo'], stdout=subprocess.PIPE).communicate()",
  "import subprocess\nsubprocess.run('echo')",
  "import subprocess as sp\nsp.run(['echo', 'x'], cwd='.', timeout=5, check=False)",
  "from subprocess import check_output as co\nco(['echo', 'x'])",
  "from os import system as s\ns('echo x')",
  "import posix\nposix.system('echo x')",
  "import os as o\no.system('echo x')",
  "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'pass'])",
  "from sys import executable as py\nimport subprocess\nsubprocess.run([py, '-V'])",
  'import os\nprint(f"{os.system(\'echo x\')}")',
  "import os\nos.system('''echo one\necho two''')",
  "import subprocess\nflag = '-n'\ntry:\n    subprocess.run(['echo', flag, 'b c'])\nexcept Exception:\n    pass",
  "import os, subprocess\ntry:\n    os.system('echo x')\nexcept Exception:\n    pass\ntry:\n    subprocess.run(['echo', 'y'])\nexcept Exception:\n    pass",
  "import subprocess, sys\ntry:\n    subprocess.run([sys.executable, '-m', 'mypy', 't.py'], capture_output=True, text=True)\nexcept RuntimeError as e:\n    print(e)\nprint(subprocess.PIPE)",
  'from subprocess import CalledProcessError\nprint(CalledProcessError.__doc__)',
];

/** Programs made of imports, calls and bindings that start processes, each call allowed to fail. */
const IMPORTS = [
  'import subprocess, os, sys',
  'import subprocess as sp',
  'import os as o',
  'from subprocess import run, Popen',
  'from subprocess import run as r',
  'from os import system',
  'from os import system as s',
].join('\n');
const ARGS = [
  "['echo', 'a']",
  "['echo', w]",
  "[w, 'a']",
  "'echo a'",
  'w',
  "['echo'] + [w]",
  "[sys.executable, '-V']",
  "('echo', 'b')",
  "['echo', f'{w}']",
];
const LINES = ["'echo a'", 'w', "'echo ' + w", "f'echo {w}'", "'''echo a'''"];
const CALLS = [
  ...ARGS.flatMap((a) => [
    `subprocess.run(${a})`,
    `sp.run(${a})`,
    `run(${a})`,
    `r(${a})`,
    `Popen(${a})`,
    `subprocess.check_output(${a})`,
    `subprocess.call(${a}, shell=True)`,
    `subprocess.run(${a}, capture_output=True, timeout=5)`,
  ]),
  ...LINES.flatMap((l) => [
    `os.system(${l})`,
    `o.system(${l})`,
    `system(${l})`,
    `s(${l})`,
    `os.popen(${l})`,
    `subprocess.getoutput(${l})`,
  ]),
];
/** Names bound to what starts processes, and used: each a way to start one that the calls above do not spell. */
const BINDINGS = [
  "w = 'echo'",
  'w = sys.executable',
  "x = subprocess; x.run(['echo', 'x'])",
  "q = sp; q.call(['echo', 'q'])",
  "run = print; run(['echo', 'run'])",
  "f = os.system; f('echo f')",
  "g = system; g('echo g')",
  "sp = os; sp.system('echo sp')",
  "o = subprocess; o.run(['echo', 'o'])",
  "os.system = print; os.system('echo p')",
  "import shutil; m = shutil.os; m.system('echo m')",
  "import shutil; m = shutil.os; m.system('echo ' + w)",
  "t = (subprocess,); t[0].run(['echo', 't'])",
];
const statement = fc.oneof(
  { weight: 1, arbitrary: fc.constant('from subprocess import *') },
  {
    weight: 12,
    arbitrary: fc
      .constantFrom(...CALLS)
      .map((call) => `try:\n    ${call}\nexcept Exception:\n    pass`),
  },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(...BINDINGS)
      .map((line) => `try:\n    ${line}\nexcept Exception:\n    pass`),
  },
);
const programs = fc
  .array(statement, { minLength: 1, maxLength: 6 })
  .map((lines) => [IMPORTS, "w = 'x'", ...lines].join('\n'));

describe.skipIf(PYTHON === null)('the interpreter agrees with the reader of processes', () => {
  it('starts nothing unread in any program of these parts that the reader says it read', () => {
    // Each binding alone, beside every import, and then programs of several parts.
    const alone = [...BINDINGS, ...CALLS].map((part) =>
      [IMPORTS, "w = 'x'", `try:\n    ${part}\nexcept Exception:\n    pass`].join('\n'),
    );
    const sample = [...alone, ...fc.sample(programs, { numRuns: 1200, seed: 20261028 })];
    const found = spawned(sample);
    let claimed = 0;
    let started = 0;
    sample.forEach((program, i) => {
      const reading = readPythonProcesses(program);
      if (reading === null || reading.unread || reading.opaque || reading.hiddenPayload) return;
      claimed += 1;
      for (const process of found[i] ?? []) {
        started += 1;
        expect(readAs(process, reading.processes), `${program}\n${JSON.stringify(process)}`).toBe(
          true,
        );
      }
    });
    // The sample has to hold programs the reader claims, and processes in them, to say anything.
    expect(claimed).toBeGreaterThan(100);
    expect(started).toBeGreaterThan(100);
  });

  it('sees the processes a program starts, so that its silence means something', () => {
    const must = [
      "import os\nos.system('echo one')",
      "import subprocess\nsubprocess.run(['echo', 'one'])",
      "import os\nos.execvp('echo', ['echo'])",
      "import os\nos.posix_spawn('/bin/echo', ['echo'], {})",
    ];
    must.forEach((program, i) => {
      expect(spawned(must)[i]?.length, program).toBeGreaterThan(0);
    });
  });

  it('starts nothing the reader did not read, in a program it says it read in full', () => {
    const found = spawned(READ);
    READ.forEach((program, i) => {
      const reading = readPythonProcesses(program);
      expect(reading?.unread, program).toBe(false);
      for (const process of found[i] ?? [])
        expect(
          readAs(process, reading?.processes ?? []),
          `${program}\n${JSON.stringify(process)}`,
        ).toBe(true);
    });
  });

  it('reads the words of each process as the interpreter is given them', () => {
    const found = spawned(READ);
    // Each of these programs starts at least one process the reader read, word for word.
    const starters = READ.filter((_, i) => (found[i]?.length ?? 0) > 0);
    expect(starters.length).toBeGreaterThan(15);
  });

  it('says it did not read what it cannot', () => {
    const programs = [
      "import os\nc = 'echo ' + 'x'\nos.system(c)",
      "import subprocess\nsubprocess.run(['echo'], executable='/bin/echo')",
      "import os\nos.execvp('echo', ['echo'])",
      "import subprocess\nf = subprocess.run\nf(['echo'])",
      "import subprocess\nx = subprocess\nx.run(['echo'])",
      "from subprocess import *\nrun(['echo'])",
    ];
    const found = spawned(programs);
    programs.forEach((program, i) => {
      expect(found[i]?.length, program).toBeGreaterThan(0);
      expect(readPythonProcesses(program)?.unread, program).toBe(true);
    });
  });
});
