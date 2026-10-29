import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { stroqStateSignals } from '../../src/actions/stroq-state.js';
import { cpuNow } from '../cpu-time.js';
import { QUOTED_BEHIND_LAUNCHERS, SPELLINGS, joined, type Spelling } from './stroq-state-matrix.js';
import {
  ORDINARY_LINES,
  PTY_ALREADY_DENIED,
  PTY_ORDINARY,
  PTY_READ,
  PTY_REPORTED,
  PTY_UNREAD,
  READING_LINES,
  STATE_LINES,
} from './stroq-state-pty-matrix.js';

/**
 * `stroq run -- <command>` and `stroq mcp -- <command>` start whatever program follows the
 * `--`, so a command of Stroq's that changes state is one when it stands there as well:
 * `stroq run -- stroq prove` was read as a `run` with an agent called `stroq`, and went
 * through. The program after the `--` is judged by the command it names, in every spelling.
 *
 * The words after that `--` belong to that program and not to `stroq run`, which is how the
 * CLI reads them (`help.ts`: `ownArgs`). So `--help`, `-h` and `--dry-run`, which keep a
 * command open, count only when they stand before it, in the command the agent typed. Behind a
 * launcher none of them opens anything: the operand is read again from words that were split on
 * blanks with their quotes taken off, so a quoted argument such as `"x -h"` would show a flag
 * that the program is never given, and `stroq run -- stroq uninstall --client "x -h"` would
 * be let through as a request for help while it runs.
 */

const STATE = ['stroq-state-change'];

/** What follows `stroq` in a call that changes state, one of each kind of rule. */
const CHANGING: ReadonlyArray<readonly string[]> = [
  ['console'],
  ['console', '--workspace', '/work', '--port', '0'],
  ['prove'],
  ['add', 'some-server'],
  ['harden', 'apply'],
  ['permit', 'revoke', '--all'],
  ['vet', '--online', './some-package'],
  ['untaint', '--all'],
  ['init'],
  ['uninstall'],
  ['trust', 'README.md'],
  ['task', '--', 'fix the failing test'],
];

/** What follows `stroq` in a call that only reads or asks. */
const READING: ReadonlyArray<readonly string[]> = [
  ['doctor'],
  ['vet', './some-package'],
  ['harden', 'status'],
  ['permit', 'list'],
  ['trust'],
];

/**
 * The spellings that are one command line, which is what the operand of a launcher is. The rest
 * of the matrix is shell syntax (a group, an `if`, `bash -c`, a heredoc) or an assignment, and
 * none of those is an argument vector.
 */
const OPERAND_SPELLINGS = [
  'the bare name',
  'an absolute path',
  'a Windows launcher',
  'a Windows executable',
  'a Windows path',
  'sudo',
  'env with an assignment',
  'env -i',
  'double-quoted words',
  'single-quoted words',
  'npx @stroq/cli',
  'npx -y with a version',
  'npx stroq',
  'pnpm dlx',
  'pnpm exec',
  'node and the published entry',
  'node and a checkout',
  'node and a Windows entry',
  'a substitution',
];
const OPERANDS: readonly Spelling[] = SPELLINGS.filter(([name]) =>
  OPERAND_SPELLINGS.includes(name),
);

/** The ways to start a program under Stroq's launchers; `operand` is the program, as written. */
const LAUNCHERS: ReadonlyArray<readonly [string, (operand: string) => string]> = [
  ['stroq run', (o) => `stroq run -- ${o}`],
  [
    'stroq run with every option',
    (o) =>
      `stroq run --agent claude-code --sandbox --allow-domain api.anthropic.com --no-inspect --force -- ${o}`,
  ],
  ['stroq mcp', (o) => `stroq mcp --server docs --client claude-desktop --cloak -- ${o}`],
  ['npx @stroq/cli run', (o) => `npx @stroq/cli run --sandbox -- ${o}`],
  ['an absolute path under sudo', (o) => `sudo /usr/local/bin/stroq run -- ${o}`],
  ['a Windows launcher', (o) => `stroq.cmd run -- ${o}`],
  ['node and a checkout', (o) => `node packages/cli/dist/index.js run -- ${o}`],
  ['env with an assignment', (o) => `env FOO=1 stroq run -- ${o}`],
  ['after &&', (o) => `ls && stroq run -- ${o}`],
  ['a group', (o) => `{ stroq run -- ${o}; }`],
  ['a subshell', (o) => `(stroq run -- ${o})`],
];

describe('a command of Stroq that changes state is one behind a launcher', () => {
  // The first went through. The second did not: a string handed to `sh -c` is read as a command
  // wherever it stands, so it was caught before launchers were read, and stays so.
  it('denies the two forms the review named', () => {
    expect(stroqStateSignals('stroq run -- stroq prove')).toEqual(STATE);
    expect(stroqStateSignals("stroq run --sandbox -- sh -c 'stroq add x'")).toEqual(STATE);
  });

  it.each(CHANGING.map((words) => [joined(words), words] as const))(
    'denies stroq %s as the operand, in every spelling and behind every launcher',
    (_title, words) => {
      for (const [launcher, wrap] of LAUNCHERS)
        for (const [name, spell] of OPERANDS) {
          const command = wrap(spell(words));
          expect(stroqStateSignals(command), `${launcher} / ${name}: ${command}`).toEqual(STATE);
        }
    },
  );

  it.each(READING.map((words) => [joined(words), words] as const))(
    'leaves stroq %s open as the operand, in every spelling and behind every launcher',
    (_title, words) => {
      for (const [launcher, wrap] of LAUNCHERS)
        for (const [name, spell] of OPERANDS) {
          const command = wrap(spell(words));
          expect(stroqStateSignals(command), `${launcher} / ${name}: ${command}`).toEqual([]);
        }
    },
  );

  // A launcher is no more than a launcher: the program it starts is judged by what it is.
  it('denies behind a program that runs another, as it does without a launcher', () => {
    for (const command of [
      'stroq run -- xargs stroq prove',
      'stroq run -- env -i PATH=/usr/bin stroq add x',
      'stroq run -- nohup stroq harden apply',
      'stroq run -- setsid stroq uninstall',
      'stroq run -- timeout 5 stroq untaint --all',
      'stroq run -- watch -n1 stroq prove',
      "stroq run --sandbox -- bash -c 'stroq remove x'",
      'stroq run --sandbox -- sh -c "stroq task -- x"',
      "stroq mcp --server s -- sh -c 'stroq init'",
    ])
      expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it('denies a launcher behind a launcher, up to a depth nobody writes', () => {
    expect(stroqStateSignals('stroq run -- stroq run -- stroq prove')).toEqual(STATE);
    expect(stroqStateSignals('stroq run -- stroq mcp --server s -- stroq add x')).toEqual(STATE);
    expect(
      stroqStateSignals('stroq run -- sudo stroq run --sandbox -- npx @stroq/cli untaint --all'),
    ).toEqual(STATE);
  });

  // A chain deeper than it is followed cannot be told apart from one built to hide what is at
  // its end, and nobody nests Stroq's launcher five deep: it is denied and not let through.
  it('denies a chain deeper than it follows, rather than letting it through', () => {
    const deep = (n: number, last: string): string => `${'stroq run -- '.repeat(n)}${last}`;
    expect(stroqStateSignals(deep(3, 'claude'))).toEqual([]);
    expect(stroqStateSignals(deep(3, 'stroq prove'))).toEqual(STATE);
    expect(stroqStateSignals(deep(12, 'claude'))).toEqual(STATE);
    expect(stroqStateSignals(deep(12, 'stroq prove'))).toEqual(STATE);
  });
});

describe('a launcher starts an agent, and that is not a change of state', () => {
  it.each([
    'stroq run -- claude',
    'stroq run -- claude --help',
    'stroq mcp --server x -- node server.js --help',
    'stroq run --sandbox -- claude -p hi',
    'stroq run --agent codex -- codex exec "fix the failing test"',
    'stroq run --sandbox --allow-domain api.anthropic.com -- claude --model opus',
    'stroq run --no-inspect --force -- cursor-agent',
    'stroq run -- npx -y some-agent --flag',
    'stroq run -- pnpm exec prettier --check .',
    'stroq run -- bash -c "npm test"',
    "stroq run -- sh -c 'echo stroq prove'",
    'stroq run -- node agent.js stroq prove',
    'stroq run -- echo stroq add x',
    'stroq run -- claude --append-system-prompt "never run stroq add"',
    'stroq run -- git add -A',
    'stroq run -- task build',
    'stroq mcp --server docs -- npx -y @modelcontextprotocol/server-filesystem /tmp',
    'stroq mcp --server db --cloak -- node server.js --add --remove --prove',
    'npx @stroq/cli run --sandbox -- claude',
    'sudo stroq run -- claude',
    'stroq run -- stroq doctor',
    'stroq run -- stroq vet ./pkg',
    'stroq run',
    'stroq run --sandbox',
    'stroq run claude',
    'stroq mcp --server x',
  ])('leaves %s alone', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
  });

  it('is judged by the whole tool call, as a command is: Bash, PowerShell and Monitor', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      expect(
        classifyTool(tool, { command: 'stroq run -- stroq prove' }, '/work').classes,
        tool,
      ).toContain('config.self');
      expect(
        classifyTool(tool, { command: 'stroq run --sandbox -- claude -p hi' }, '/work').classes,
        tool,
      ).not.toContain('config.self');
    }
  });
});

describe('the words after "--" are the other program’s, not the ones that open a command', () => {
  // A prompt that mentions `--help` is a prompt: it starts a task all the same.
  it.each([
    "stroq task -- 'fix --help'",
    'stroq task -- fix --help',
    'stroq task -- "document the -h flag"',
    "stroq task -- 'add a --dry-run option'",
    'stroq task -- --help',
    'stroq task -- fix the bug -- --dry-run',
    "npx @stroq/cli task -- 'fix --help'",
    "sudo stroq task -- 'fix -h'",
  ])('does not take the flag in %s for a request for help', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it.each([
    'stroq task --help',
    'stroq task -h',
    "stroq task --dry-run -- 'x'",
    "stroq task --help -- 'x'",
    "stroq task -h -- 'fix it'",
    'stroq task --dry-run',
    'npx @stroq/cli task --help',
  ])('still lets %s through, where the flag is the command’s own', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
  });

  // A flag after the `--` of `stroq run` is not `stroq run`'s, so it does not open the launcher for
  // whatever it starts, and `stroq run` cannot vouch for what the program behind it does with the
  // flag either: `stroq run -- stroq prove --help` is denied as `stroq run -- stroq prove` is. A
  // request for help is made without a launcher.
  it.each([
    'stroq run -- stroq prove --help',
    'stroq run -- stroq prove -h',
    'stroq run -- stroq add x --dry-run',
    'stroq run -- stroq init --dry-run',
    'stroq run -- stroq task --help',
    'stroq run --sandbox -- stroq harden apply --help',
    'stroq mcp --server s -- stroq untaint -h',
    'stroq run -- stroq run -- stroq prove --help',
    'stroq run -- env -i stroq prove --help',
    'stroq run -- xargs stroq prove --dry-run',
    'npx @stroq/cli run -- npx @stroq/cli add x --help',
    'sudo stroq run --sandbox -- sudo stroq remove x -h',
  ])('does not take the flag behind the launcher in %s for a request for help', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it('still denies what stands next to a flag of the operand, and what the string of a shell holds', () => {
    expect(stroqStateSignals('stroq run -- stroq prove && stroq prove --help')).toEqual(STATE);
    expect(stroqStateSignals('stroq run -- sh -c "stroq add x --help; stroq add y"')).toEqual(
      STATE,
    );
    expect(stroqStateSignals('stroq run -- stroq task -- fix --help')).toEqual(STATE);
  });

  // The command line of a shell that a launcher starts is read as it is without one: the string
  // after `-c` is a command line of its own, and the flag in it belongs to the command in it.
  it('reads a flag in the string of a shell as it would without a launcher', () => {
    expect(stroqStateSignals('sh -c "stroq prove --help"')).toEqual([]);
    expect(stroqStateSignals('stroq run -- sh -c "stroq prove --help"')).toEqual([]);
  });

  // The operand is read again from the words of the line, which were split on blanks with their quotes
  // taken off: a quoted argument that holds a flag became a word that is one. Verified by the review of
  // 2026-10-10, each of these ran the command it names.
  it.each(QUOTED_BEHIND_LAUNCHERS.map((command) => [command]))(
    'does not read the flag inside a quoted argument of the operand: %s',
    (command) => {
      expect(stroqStateSignals(command), command).toEqual(STATE);
    },
  );

  // A launcher that is not started by anyone is the one case where a flag of the operand is a flag
  // of a command that is not run: a request for help for `stroq run` stops before the `--`.
  it('keeps a flag of the operand out of the exemption even when the launcher is asked for help', () => {
    expect(stroqStateSignals('stroq run --help -- stroq prove --help')).toEqual([]);
    expect(stroqStateSignals('stroq run -- stroq prove --help --dry-run')).toEqual(STATE);
  });

  it('does not let a flag of the operand cover a change of state next to it', () => {
    expect(stroqStateSignals('stroq run -- stroq prove --help && stroq prove')).toEqual(STATE);
    expect(stroqStateSignals('stroq run -- stroq prove --help; stroq add x')).toEqual(STATE);
  });

  it('keeps open what the launcher was asked to only describe', () => {
    expect(stroqStateSignals('stroq run --help -- stroq prove')).toEqual([]);
    expect(stroqStateSignals('stroq run -h -- stroq prove')).toEqual([]);
    expect(stroqStateSignals('stroq run --dry-run -- stroq prove')).toEqual([]);
    expect(stroqStateSignals('stroq mcp --help')).toEqual([]);
  });

  // A command that does not hand its words on keeps every word as its own: there is no program
  // behind it to own the rest.
  it('reads the flags of a command that is not a launcher wherever they stand', () => {
    expect(stroqStateSignals('stroq prove --help')).toEqual([]);
    expect(stroqStateSignals('stroq add some-server --dry-run')).toEqual([]);
    expect(stroqStateSignals('stroq harden apply -h')).toEqual([]);
    expect(stroqStateSignals('stroq untaint --all')).toEqual(STATE);
  });
});

/**
 * A program that runs a command inside a pseudo-terminal (`script`, `unbuffer`, `expect`, `socat … EXEC:`, an
 * interpreter that calls `pty.spawn`) is a launcher as `stroq run --` is. Where the command it runs can be read,
 * it is read as a command line of its own, behind which no flag asks for help; where it is handed to a program
 * that is not read (a Tcl script that is not plain, a program of Python, Perl or Ruby, a shell that is typed
 * into), it is denied when that text names Stroq.
 */
const isSelf = (command: string): boolean =>
  classifyTool('Bash', { command }, '/work').classes.includes('config.self');
describe('a command of Stroq run inside a pseudo-terminal', () => {
  it.each(PTY_REPORTED.map((command) => [command]))(
    'denies %s, which went through on 2026-10-13',
    (command) => {
      expect(stroqStateSignals(command), command).toEqual(STATE);
      expect(isSelf(command), command).toBe(true);
    },
  );

  it.each(PTY_ALREADY_DENIED.map((command) => [command]))('still denies %s', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
    expect(isSelf(command), command).toBe(true);
  });

  it.each(PTY_READ.map(([name, launch]) => [name, launch] as const))(
    'denies a command that changes state behind %s, in every spelling',
    (_name, launch) => {
      for (const line of STATE_LINES)
        expect(stroqStateSignals(launch(line)), launch(line)).toEqual(STATE);
    },
  );

  it.each(PTY_UNREAD.map(([name, launch]) => [name, launch] as const))(
    'denies a command of Stroq handed to what is not read: %s',
    (_name, launch) => {
      for (const line of [...STATE_LINES, ...READING_LINES])
        expect(stroqStateSignals(launch(line)), launch(line)).toEqual(STATE);
    },
  );

  it.each(PTY_READ.map(([name, launch]) => [name, launch] as const))(
    'leaves a command of Stroq that only reads open behind %s',
    (_name, launch) => {
      for (const line of READING_LINES)
        expect(stroqStateSignals(launch(line)), launch(line)).toEqual([]);
    },
  );

  it.each([...PTY_READ, ...PTY_UNREAD].map(([name, launch]) => [name, launch] as const))(
    'leaves ordinary work open behind %s',
    (_name, launch) => {
      for (const line of ORDINARY_LINES) {
        expect(stroqStateSignals(launch(line)), launch(line)).toEqual([]);
        expect(isSelf(launch(line)), launch(line)).toBe(false);
      }
    },
  );

  it.each(PTY_ORDINARY.map((command) => [command]))('leaves %s open', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
    expect(isSelf(command), command).toBe(false);
  });

  it('reads a name that a variable gives Stroq', () => {
    for (const command of [
      'S=stroq; script -q /dev/null $S untaint',
      'S=stroq; script -qc "$S untaint" /dev/null',
      'S=stroq; expect -c "spawn $S untaint"',
      'S=stroq; socat - EXEC:"$S untaint",pty',
    ])
      expect(stroqStateSignals(command), command).toEqual(STATE);
    expect(stroqStateSignals('S=make; script -q /dev/null $S test')).toEqual([]);
  });

  // The line a pty launcher runs is rebuilt from words whose quotes are gone, so its flags are not
  // certainly the ones the program is handed: no flag in it opens the command, as behind `stroq run --`.
  // `unbuffer` is a wrapper read word by word where the command stands, and keeps the command's own flags.
  it('lets no request for help open a command behind a pty launcher', () => {
    for (const command of [
      'script -q /dev/null stroq untaint --help',
      'script -qc "stroq untaint -h" /dev/null',
      'ptyexec stroq untaint --version',
      'pty stroq add x --help',
      'socat - EXEC:"stroq prove --help",pty',
      'expect -c "spawn stroq untaint --help"',
      'stroq run -- script -q /dev/null stroq untaint --help',
      'stroq run -- stroq untaint --help',
    ])
      expect(stroqStateSignals(command), command).toEqual(STATE);
    expect(stroqStateSignals('unbuffer stroq untaint -h')).toEqual([]);
  });

  it('is judged by the whole tool call: Bash, PowerShell and Monitor', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      expect(
        classifyTool(tool, { command: 'script -q /dev/null stroq untaint' }, '/work').classes,
        tool,
      ).toContain('config.self');
      expect(
        classifyTool(tool, { command: 'script -q /dev/null make test' }, '/work').classes,
        tool,
      ).not.toContain('config.self');
    }
  });

  // A chain of launchers deeper than it is followed is denied where it names Stroq, and left alone where it
  // does not: nobody nests `script` five deep, and the end of such a chain is not read.
  it('denies a chain deeper than it follows only where it names Stroq', () => {
    const deep = (n: number, last: string): string => `${'script -q /dev/null '.repeat(n)}${last}`;
    expect(stroqStateSignals(deep(3, 'stroq untaint'))).toEqual(STATE);
    expect(stroqStateSignals(deep(12, 'stroq doctor'))).toEqual(STATE);
    expect(stroqStateSignals(deep(12, 'make test'))).toEqual([]);
    expect(stroqStateSignals(deep(3, 'stroq doctor'))).toEqual([]);
  });
});

// Found by a review of the first reading of pty launchers (2026-10-27). An interpreter's program, and an expect
// script, are not read for the words that start a process: a list of them is never whole (backticks, `%x`,
// `qx`, `Open3`, `create_subprocess_shell`). Where the program is anything but a file named first, it is text
// the gate does not read, and it is denied where it names Stroq as a program: the name, a path to it, the
// package, the entry file, or a variable that holds one of them.
describe('what a pty launcher or an interpreter is given is denied where it is not read', () => {
  it.each([
    'python3.12 -c \'import pty; pty.spawn(["stroq","untaint"])\'',
    'pypy3 -c \'import os; os.system("stroq untaint")\'',
    'ruby3.3 -e \'PTY.spawn("stroq untaint")\'',
    'node22 -e \'require("child_process").execSync("stroq untaint")\'',
    'php8.2 -r \'shell_exec("stroq untaint");\'',
    'lua5.4 -e \'os.execute("stroq untaint")\'',
    "ruby -e '`stroq untaint`'",
    "ruby -e '%x(stroq untaint)'",
    "perl -e 'qx(stroq untaint)'",
    "perl -E 'say `stroq untaint`'",
    'ruby -ropen3 -e \'Open3.capture2("stroq untaint")\'',
    'python3 -c \'import asyncio; asyncio.run(asyncio.create_subprocess_shell("stroq untaint"))\'',
    'node --print \'require("child_process").execSync("stroq untaint")+""\'',
    'node --eval=\'require("child_process").execSync("npx @stroq/cli untaint")\'',
    'deno eval \'new Deno.Command("stroq",{args:["untaint"]}).outputSync()\'',
    'bun eval \'Bun.spawnSync(["/usr/local/bin/stroq","untaint"])\'',
    'python3 -c \'import os; os.system("node packages/cli/dist/index.js untaint")\'',
    'S=stroq; python3 -c "import os; os.system(\'$S untaint\')"',
    'python3 <<< \'import os; os.system("stroq untaint")\'',
    'node --no-warnings packages/cli/dist/index.js untaint',
  ])('denies the interpreter program %s', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
    expect(isSelf(command), command).toBe(true);
  });

  it.each([
    'echo \'import os; os.system("stroq untaint")\' | python3',
    'echo \'import os; os.system("stroq untaint")\' | python3 -',
    'echo \'import os; os.system("stroq untaint")\' | python3 -W ignore',
    'python3 - <<\'EOF\'\nimport os; os.system("stroq untaint")\nEOF',
    'node <<\'EOF\'\nrequire("child_process").execSync("stroq untaint")\nEOF',
    "printf 'spawn stroq untaint\\ninteract\\n' | expect",
    "printf 'spawn stroq untaint\\n' | expect -",
    "printf 'spawn stroq untaint\\n' | expect -i",
    "printf 'spawn stroq untaint\\n' | expect -D 1",
    "expect -f - <<'EOF'\nspawn stroq untaint\nEOF",
    "expect <<< 'spawn stroq untaint'",
  ])('denies a program read from the input of %s', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
    expect(isSelf(command), command).toBe(true);
  });

  it.each([
    "expect -c'spawn stroq untaint'",
    "expect -c'spawn stroq doctor; exec stroq untaint'",
    'expect -fstroq-script.exp stroq',
    "expect -d -c 'spawn stroq untaint'",
    "expect -c 'system stroq untaint'",
    "expect -c 'eval spawn stroq untaint'",
    'expect -c \'set f [open "|stroq untaint"]\'',
    'expect -c \'spawn "stroq" untaint\'',
  ])('denies the expect invocation %s', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it.each([
    'socat - \'EXEC:"stroq untaint"!!STDOUT\'',
    "socat 'STDIN!!EXEC:stroq untaint' -",
    "socat - 'SYSTEM:echo hi!!EXEC:stroq untaint'",
    "socat - ' EXEC:stroq untaint'",
    'socat - \'EXEC:"stroq doctor"\'',
  ])('denies the socat address %s', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it.each([
    'script -q /dev/null make test',
    "expect -c 'spawn ssh host'",
    "expect -d -c 'spawn ssh host'",
    'expect deploy.exp',
    'unbuffer npm test',
    "python3 -c 'print(1)'",
    "python3.12 -c 'import json,sys; print(json.load(sys.stdin))'",
    'python3 build.py --name stroq',
    'python3 build.py < stroq-notes.txt',
    'node scripts/release.js stroq',
    'node packages/cli/dist/index.js doctor',
    'node --test /work/stroq/console/scripts/session-taint-worker.test.mjs',
    'cd ~/Documents/stroq && node --test scripts/a.test.mjs',
    'grep stroq log.txt | python3 -c \'import sys; print(sys.stdin.read().count("x"))\'',
    "cat notes | python3 -c 'import sys; print(len(sys.stdin.read()))'",
    "perl -pi -e 's/stroq@0.1/stroq@0.2/' README.md",
    'echo hi | python3',
    'socat - EXEC:"ssh host",pty',
    'socat TCP-LISTEN:8080,fork TCP:stroq.dev:443',
    "socat - 'SYSTEM:echo hi!!STDOUT'",
  ])('leaves %s open', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
    expect(isSelf(command), command).toBe(false);
  });

  // The cost of not reading the program: one that only prints the name is denied too.
  it('denies an inline program that names Stroq as data', () => {
    expect(stroqStateSignals('python3 -c \'print("stroq")\'')).toEqual(STATE);
  });
});

describe('a chain of launchers is read in a time that grows with its length', () => {
  const SMALL = 8 * 1024;
  const LARGE = 64 * 1024;
  const at = (unit: string, size: number, tail: string): string =>
    unit.repeat(Math.ceil(size / unit.length)) + tail;

  const cost = (command: string): number => {
    const started = cpuNow();
    stroqStateSignals(command);
    return cpuNow() - started;
  };

  it.each([
    ['stroq run -- ', 'claude'],
    ['stroq run -- ', 'stroq prove'],
    ['stroq mcp --server x -- ', 'node server.js'],
    ['stroq run --sandbox --agent x -- ', 'claude'],
    ['sudo stroq run -- ', 'env -i stroq add x'],
    ['stroq run -- -- ', 'claude'],
    ['stroq run ', ''],
    ['stroq run -- sh -c ', ''],
    ['script -q /dev/null ', 'stroq untaint'],
    ['script -q /dev/null ', 'make test'],
    ['script -qc ', 'stroq untaint'],
    ['unbuffer -p ', 'stroq untaint'],
    ['expect -c "spawn ', 'stroq untaint'],
    ['socat - EXEC:', 'stroq untaint'],
    ['echo stroq | script -q /dev/null ', ''],
    ["python3 -c 'import pty; ", 'stroq'],
  ])('%j then %j', (unit, tail) => {
    // Twice: the first call pays for loading what it needs, and a single timing of a few
    // milliseconds is noise.
    cost(at(unit, SMALL, tail));
    const small = Math.max(1, cost(at(unit, SMALL, tail)));
    const large = cost(at(unit, LARGE, tail));
    // Eight times the size: linear work takes about eight times as long, quadratic work sixty-four.
    expect(large < 1_000 || large < 24 * small, `${small} ms at 8 KiB, ${large} ms at 64 KiB`).toBe(
      true,
    );
  });
});
