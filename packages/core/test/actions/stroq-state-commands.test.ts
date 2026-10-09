import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { stroqStateSignals } from '../../src/actions/stroq-state.js';

/**
 * The commands of Stroq that an agent must not run itself (`untaint`, `init`, `uninstall`,
 * `trust <file>`) are listed in `stroq-state.ts`, and `self-config.test.ts` holds that list to a
 * long run of spellings. The commands that are still to come (`harden apply|undo|forget`,
 * `prove`, `add`, `remove`, `vet --online`, `task`, `permit extend|revoke`) are listed ahead of
 * their code, and each has to be judged exactly as `untaint` is, in the same spellings. The
 * list is a denylist: the reading forms of the same commands, and any subcommand it does not
 * name, stay open.
 */

type Spelling = readonly [name: string, spell: (words: readonly string[]) => string];

const joined = (words: readonly string[]): string => words.join(' ');
const quoted = (mark: string, words: readonly string[]): string =>
  words.map((word) => `${mark}${word}${mark}`).join(' ');

/** How a command of Stroq reaches a shell, from the matrix `self-config.test.ts` has for `untaint`. */
const SPELLINGS: readonly Spelling[] = [
  ['the bare name', (w) => `stroq ${joined(w)}`],
  ['an absolute path', (w) => `/usr/local/bin/stroq ${joined(w)}`],
  ['a Windows launcher', (w) => `stroq.cmd ${joined(w)}`],
  ['a Windows executable', (w) => `stroq.exe ${joined(w)}`],
  ['a Windows path', (w) => `C:\\Users\\dev\\AppData\\Roaming\\npm\\stroq.cmd ${joined(w)}`],
  ['sudo', (w) => `sudo stroq ${joined(w)}`],
  ['an assignment in front', (w) => `STROQ_HOME=/tmp/h stroq ${joined(w)}`],
  ['env with an assignment', (w) => `env FOO=1 stroq ${joined(w)}`],
  ['env -i', (w) => `env -i stroq ${joined(w)}`],
  ['double-quoted words', (w) => `stroq ${quoted('"', w)}`],
  ['single-quoted words', (w) => `stroq ${quoted("'", w)}`],
  ['npx @stroq/cli', (w) => `npx @stroq/cli ${joined(w)}`],
  ['npx -y with a version', (w) => `npx -y @stroq/cli@0.23.0 ${joined(w)}`],
  ['npx stroq', (w) => `npx stroq ${joined(w)}`],
  ['pnpm dlx', (w) => `pnpm dlx @stroq/cli ${joined(w)}`],
  ['pnpm exec', (w) => `pnpm exec stroq ${joined(w)}`],
  [
    'node and the published entry',
    (w) => `node /opt/node_modules/@stroq/cli/dist/index.js ${joined(w)}`,
  ],
  ['node and a checkout', (w) => `node packages/cli/dist/index.js ${joined(w)}`],
  [
    'node and a Windows entry',
    (w) => `node C:\\dev\\node_modules\\@stroq\\cli\\dist\\index.js ${joined(w)}`,
  ],
  ['a substitution', (w) => `$(which stroq) ${joined(w)}`],
  ['a variable', (w) => `S=stroq; $S ${joined(w)}`],
  ['bash -c', (w) => `bash -c "stroq ${joined(w)}"`],
  ['sh -c with single quotes', (w) => `sh -c 'stroq ${joined(w)}'`],
  ['a heredoc to bash', (w) => `bash <<'EOF'\nstroq ${joined(w)}\nEOF`],
  ['xargs', (w) => `echo | xargs -I{} stroq ${joined(w)}`],
  ['after &&', (w) => `ls && stroq ${joined(w)}`],
  ['a group', (w) => `{ stroq ${joined(w)}; }`],
  ['a subshell', (w) => `(stroq ${joined(w)})`],
  ['an if', (w) => `if true; then stroq ${joined(w)}; fi`],
  ['a function', (w) => `f() { stroq ${joined(w)}; }; f`],
];

const UNTAINT = ['untaint', '--all'] as const;

/** A case per list of words, titled by the command line they make. */
const cases = (
  lists: ReadonlyArray<readonly string[]>,
): ReadonlyArray<readonly [string, readonly string[]]> =>
  lists.map((words) => [joined(words), words]);

/** What follows `stroq` in a call that changes state. */
const CHANGING: ReadonlyArray<readonly string[]> = [
  ['harden', 'apply'],
  ['harden', 'apply', '--yes'],
  ['harden', '--yes', 'apply'],
  ['harden', '--scope', 'user', 'apply'],
  ['harden', 'undo'],
  ['harden', 'forget'],
  ['prove'],
  ['prove', 'claude-code'],
  ['prove', '--agent', 'claude-code'],
  ['add', 'some-server'],
  ['add', '--yes', 'some-server'],
  ['remove', 'some-server'],
  ['vet', '--online', './some-package'],
  ['vet', './some-package', '--online'],
  ['vet', '--online=true', './some-package'],
  ['task', '--', 'fix the failing test'],
  ['task'],
  ['permit', 'extend', 'task-1', 'abc123'],
  ['permit', 'extend', 'task-1', 'abc123', '--ttl', '5m'],
  ['permit', 'revoke', 'task-1'],
  ['permit', 'revoke', '--all'],
];

/** What follows `stroq` in a call that only reads, or only asks how it works. */
const READING: ReadonlyArray<readonly string[]> = [
  ['vet', './some-package'],
  ['vet', './some-package', '--json'],
  ['harden'],
  ['harden', 'status'],
  ['harden', 'plan'],
  ['harden', '--scope', 'user', 'status'],
  ['permit'],
  ['permit', 'list'],
  ['permit', 'list', '--json'],
  ['permit', 'show', 'task-1'],
  ['--help'],
  ['prove', '--help'],
  ['prove', '-h'],
  ['harden', 'apply', '--help'],
  ['harden', 'undo', '--dry-run'],
  ['task', '--help'],
  ['add', '-h'],
  ['remove', '--dry-run', 'some-server'],
  ['permit', 'revoke', '--help'],
  ['vet', '--online', '--help'],
  ['doctor'],
];

describe('the matrix of spellings', () => {
  // The control. Everything below says "as `untaint` is", which would mean nothing if
  // `untaint` were missed in one of these spellings: a gap there is not this file's to fix.
  it.each(SPELLINGS)('catches stroq untaint when it is spelled as %s', (name, spell) => {
    expect(stroqStateSignals(spell(UNTAINT)), spell(UNTAINT)).toEqual(['stroq-state-change']);
  });
});

describe("changing Stroq's own state through the commands that come after 0.23", () => {
  it.each(cases(CHANGING))(
    'treats stroq %s as it treats stroq untaint, in every spelling',
    (_title, words) => {
      for (const [name, spell] of SPELLINGS) {
        const label = `${name}: ${spell(words)}`;
        expect(stroqStateSignals(spell(words)), label).toEqual(['stroq-state-change']);
        expect(stroqStateSignals(spell(words)), label).toEqual(stroqStateSignals(spell(UNTAINT)));
      }
    },
  );

  it.each(cases(READING))('leaves stroq %s open, in every spelling', (_title, words) => {
    for (const [name, spell] of SPELLINGS) {
      expect(stroqStateSignals(spell(words)), `${name}: ${spell(words)}`).toEqual([]);
    }
  });

  // `add` and `remove` are what most package managers call theirs: only the command
  // position, and only Stroq's own program, may count.
  it.each([
    'git add -A',
    'git remote remove origin',
    'npm remove lodash',
    'npm install --save-dev @stroq/cli',
    'pnpm add -D @stroq/cli',
    'pnpm remove @stroq/cli',
    'yarn add @stroq/cli',
    'cargo add serde',
    'task build',
    'make task',
    'echo stroq harden apply',
    'echo stroq task start',
    'grep "stroq permit revoke" notes.md',
    'git commit -m "docs: stroq prove and stroq add"',
    "git commit -m 'stroq task\nstroq permit extend'",
    "cat > NOTES.md <<'EOF'\nRun:\nstroq harden apply\nstroq remove x\nEOF",
  ])('leaves %s alone: it is not a command of Stroq', (command) => {
    expect(stroqStateSignals(command)).toEqual([]);
  });

  // The list names what is denied; it does not name what is allowed. A subcommand it has not
  // been told about is open, as every reading command always was.
  it('stays a denylist: a subcommand that is not on it is open', () => {
    for (const command of ['stroq harden plan', 'stroq permit inspect task-1', 'stroq frobnicate'])
      expect(stroqStateSignals(command), command).toEqual([]);
  });

  it('still reads the command after a heredoc ends', () => {
    expect(stroqStateSignals("cat > N.md <<'EOF'\ntext\nEOF\nstroq harden apply")).toEqual([
      'stroq-state-change',
    ]);
  });

  it('keeps denying what it denied before, and still leaves `trust` with no file open', () => {
    for (const command of [
      'stroq untaint --all',
      'stroq init',
      'stroq uninstall',
      'stroq trust README.md',
      'stroq trust --remove README.md',
    ])
      expect(stroqStateSignals(command), command).toEqual(['stroq-state-change']);
    for (const command of [
      'stroq trust',
      'stroq trust --list',
      'stroq doctor',
      'stroq init --dry-run',
    ])
      expect(stroqStateSignals(command), command).toEqual([]);
  });
});

// The signal is a `config.self` for every tool that runs a shell command, so the policy
// decides on it as it does for `untaint`; the same words in other tools are not commands.
describe('what the classifier does with them', () => {
  it.each([
    ['Bash', 'stroq harden apply'],
    ['PowerShell', 'stroq.exe harden undo'],
    ['Monitor', 'stroq task -- "refactor the parser"'],
    ['Bash', 'npx @stroq/cli permit revoke --all'],
    ['Bash', 'stroq vet --online ./pkg'],
  ])('%s: %s is config.self', (tool, command) => {
    expect(classifyTool(tool, { command }, '/work').classes).toContain('config.self');
  });

  it.each([
    ['Bash', 'stroq vet ./pkg'],
    ['Bash', 'stroq harden status'],
    ['PowerShell', 'stroq.exe permit list'],
    ['Monitor', 'stroq permit show task-1'],
  ])('%s: %s is not', (tool, command) => {
    expect(classifyTool(tool, { command }, '/work').classes).not.toContain('config.self');
  });
});
