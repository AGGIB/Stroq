import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { stroqStateSignals } from '../../src/actions/stroq-state.js';
import { cpuNow } from '../cpu-time.js';
import { SPELLINGS, joined, type Spelling } from './stroq-state-matrix.js';

/**
 * `stroq run -- <command>` and `stroq mcp -- <command>` start whatever program follows the
 * `--`, so a command of Stroq's that changes state is one when it stands there as well:
 * `stroq run -- stroq prove` was read as a `run` with an agent called `stroq`, and went
 * through. The program after the `--` is judged as it would be alone, in every spelling.
 *
 * The words after that `--` belong to that program and not to `stroq run`, which is how the
 * CLI reads them (`help.ts`: `ownArgs`). So `--help`, `-h` and `--dry-run`, which keep a
 * command open, count only when they stand before it.
 */

const STATE = ['stroq-state-change'];

/** What follows `stroq` in a call that changes state, one of each kind of rule. */
const CHANGING: ReadonlyArray<readonly string[]> = [
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
  ['prove', '--help'],
  ['init', '--dry-run'],
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
  // whatever it starts. It is read where it belongs, among the words of the operand, which is
  // judged as it would be alone: a request for help from `stroq prove` is open there, as it is
  // without a launcher, and a change of state next to it is not.
  it('judges the operand by its own flags: help for it is open, a change of state is not', () => {
    expect(stroqStateSignals('stroq run -- stroq prove --help')).toEqual([]);
    expect(stroqStateSignals('stroq run -- stroq prove -h')).toEqual([]);
    expect(stroqStateSignals('stroq run -- stroq add x --dry-run')).toEqual([]);
    expect(stroqStateSignals('stroq run --sandbox -- stroq harden apply --help')).toEqual([]);
    expect(stroqStateSignals('stroq mcp --server s -- stroq untaint -h')).toEqual([]);
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

  // A request for help made to the launcher itself stops before the `--`; a flag of the operand does
  // not cover a change of state that stands next to it.
  it('does not let a flag of the launcher or of its operand cover a change of state next to it', () => {
    expect(stroqStateSignals('stroq run --help -- stroq prove --help')).toEqual([]);
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
