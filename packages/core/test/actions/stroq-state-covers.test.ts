import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { stroqStateSignals } from '../../src/actions/stroq-state.js';
import { COVERED_BY_TEXT, COVERS, SPELLINGS, joined } from './stroq-state-matrix.js';

/**
 * A flag that asks for help (`--help`, `-h`) or for a dry run (`--dry-run`) keeps a command of
 * Stroq's open: the CLI prints its usage, or what it would do, and changes nothing. That holds
 * only when the shell gives the flag to the command. A reader that takes every word of the text
 * for an argument also finds it in a comment, in the body of a heredoc, in the target of a
 * redirect and inside a quoted argument, and in each of them the command runs. The 2026-10-10
 * reviews ran the commands of `COVERED_BY_TEXT` past the gate that way.
 *
 * The flag counts only among the words the shell hands to the command the agent typed. Behind a
 * launcher it counts nowhere (`stroq-state-launchers.test.ts`).
 */

const STATE = ['stroq-state-change'];

/** One call of each kind of rule that changes state, the commands that are listed ahead of their code among them. */
const CALLS: ReadonlyArray<readonly string[]> = [
  ['untaint', '--all'],
  ['init'],
  ['uninstall'],
  ['trust', 'README.md'],
  ['trust', '--remove', 'README.md'],
  ['prove'],
  ['add', 'some-server'],
  ['remove', 'some-server'],
  ['harden', 'apply'],
  ['harden', '--scope', 'user', 'undo'],
  ['permit', 'revoke', '--all'],
  ['vet', '--online', './some-package'],
  ['task', '--', 'fix the failing test'],
  ['task'],
  ['exposure', '--probe'],
  ['canary'],
  ['canary', '--file', '/tmp/decoy', '--name', 'DECOY'],
];

const cases = (
  lists: ReadonlyArray<readonly string[]>,
): ReadonlyArray<readonly [string, readonly string[]]> =>
  lists.map((words) => [joined(words), words]);

describe('the commands the reviews ran past the gate', () => {
  it.each(COVERED_BY_TEXT.map((command) => [command]))('denies %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it('denies them as the classifier reads a Bash, a PowerShell and a Monitor command', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor'])
      for (const command of COVERED_BY_TEXT)
        expect(classifyTool(tool, { command }, '/work').classes, `${tool}: ${command}`).toContain(
          'config.self',
        );
  });
});

describe('text that is no argument of a command does not make it a request for help', () => {
  it.each(cases(CALLS))('denies stroq %s under every cover, in every spelling', (_title, words) => {
    for (const [spelling, spell] of SPELLINGS)
      for (const [cover, covered] of COVERS) {
        const command = covered(spell(words));
        expect(stroqStateSignals(command), `${spelling} / ${cover}: ${command}`).toEqual(STATE);
      }
  });
});

describe('a command behind a launcher is held to the same covers', () => {
  const LAUNCHERS: ReadonlyArray<readonly [string, (operand: string) => string]> = [
    ['stroq run', (o) => `stroq run -- ${o}`],
    ['stroq run with options', (o) => `stroq run --agent claude-code --sandbox --force -- ${o}`],
    ['stroq mcp', (o) => `stroq mcp --server docs --cloak -- ${o}`],
    ['npx @stroq/cli run', (o) => `npx @stroq/cli run --sandbox -- ${o}`],
    ['sudo and an absolute path', (o) => `sudo /usr/local/bin/stroq run -- ${o}`],
    ['stroq run behind stroq run', (o) => `stroq run -- stroq run -- ${o}`],
  ];
  const OPERANDS = SPELLINGS.filter(([name]) =>
    ['the bare name', 'sudo', 'npx @stroq/cli', 'double-quoted words', 'env -i'].includes(name),
  );

  it.each(cases(CALLS))('denies stroq %s under every cover', (_title, words) => {
    for (const [launcher, wrap] of LAUNCHERS)
      for (const [name, spell] of OPERANDS)
        for (const [cover, covered] of COVERS) {
          const command = covered(wrap(spell(words)));
          expect(
            stroqStateSignals(command),
            `${launcher} / ${name} / ${cover}: ${command}`,
          ).toEqual(STATE);
        }
  });

  it('denies a flag of the operand wherever it stands, as a word of its own as well', () => {
    for (const flag of ['--help', '-h', '--dry-run'])
      for (const [launcher, wrap] of LAUNCHERS)
        for (const words of [['prove'], ['untaint', '--all'], ['trust', 'x.md']])
          expect(
            stroqStateSignals(wrap(`stroq ${joined(words)} ${flag}`)),
            `${launcher}: ${flag}`,
          ).toEqual(STATE);
  });
});

// The path of a Windows program is read by the words of the line, and not by the reader of the shell, which
// takes a backslash for an escape and cannot find `stroq.cmd` in `C:\...\stroq.cmd`. Those words keep a quoted
// string whole as well, so a flag inside one is not a flag, and a redirect's target is not an argument.
describe('a command spelled with a Windows path is held to the same covers', () => {
  const PATH = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\stroq.cmd';

  it.each([
    `${PATH} uninstall --client "x -h"`,
    `${PATH} untaint --all 'x --help'`,
    `${PATH} trust "evil.md --dry-run"`,
    `${PATH} untaint --all > --help`,
    `${PATH} untaint --all 2> -h`,
    `${PATH} untaint --all < --help`,
    `${PATH} untaint --all <<< --help`,
    `${PATH} untaint --all # --help`,
    `${PATH} untaint --all <<EOF\n--help\nEOF`,
    `stroq.exe uninstall --client "a -h b"`,
  ])('denies %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it.each([
    `${PATH} untaint --help`,
    `${PATH} init --dry-run`,
    `${PATH} uninstall -h > out.txt`,
    `${PATH} prove "--help"`,
    `${PATH} untaint --all --help # why`,
  ])('leaves %j open, where the flag is an argument of its own', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
  });
});

describe('a request for help that the shell gives to the command still opens it', () => {
  it.each([
    'stroq untaint --help # why',
    'stroq init --dry-run # preview, then run it without',
    'stroq prove -h #and the rest of the line is a comment',
    'stroq uninstall --dry-run # --help',
    'stroq run --help -- stroq prove # --help',
    'stroq mcp -h # how it is used',
    'stroq.exe untaint --help <# why #>',
    'stroq prove -h <#x#>',
  ])('leaves %j open where the flag comes before the comment', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
  });

  // A heredoc puts text on the line that is not the command's arguments, and a reader that cannot tell which
  // words are which does not take any of them for a request for help: the command is asked about.
  it.each([
    'stroq prove --help <<EOF\nsome text\nEOF',
    "stroq trust -h <<'EOF'\nsome text\nEOF",
    'cat <<EOF; stroq untaint --all\n--help\nEOF',
    'echo x <<EOF && stroq init\n-h\nEOF',
    'cat <<EOF | stroq uninstall\n--dry-run\nEOF',
  ])('counts no flag at all where the command carries a heredoc: %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it('opens a command whose flag is a word of its own after a quoted argument', () => {
    expect(stroqStateSignals('stroq untaint "--all" --help')).toEqual([]);
    expect(stroqStateSignals("stroq prove 'x y' -h")).toEqual([]);
  });

  it('reads the flag glued to a hash that is inside a word as the flag it is', () => {
    expect(stroqStateSignals('stroq prove a#b --help')).toEqual([]);
  });
});

describe('a comment is read as a comment, whatever it holds', () => {
  // `joinText` folded the line breaks of what a quote holds, and took the apostrophe of a comment for the
  // start of a quote: the command on the next line was part of the "string", folded into the comment.
  it.each([
    "# it's a comment\nstroq untaint --all",
    "stroq doctor # don't\nstroq untaint --all",
    'stroq doctor # "quoted\nstroq untaint --all',
    "x=1 # it's a comment\nstroq init",
    'echo hi # <<EOF\nstroq untaint --all\nEOF',
    "echo hi # <<'EOF'\nstroq uninstall",
    'ls # a `tick\nstroq untaint --all',
    "# don't\n# won't\nstroq untaint --all",
  ])('reads the line after a comment: %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it.each([
    'git commit -m "fix # the thing\n\nstroq untaint --all"',
    "echo '# it'\"'\"'s\nstroq init'",
    'echo "a # b" && echo ok',
    'echo a#b',
    'echo $#',
    'echo ${#PATH}',
  ])('does not take a hash inside text or a word for a comment: %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual([]);
  });

  it('still finds the command that stands after a hash that is inside a word', () => {
    expect(stroqStateSignals("echo a#b 'c\nd'\nstroq untaint --all")).toEqual(STATE);
    expect(stroqStateSignals('echo a#b\nstroq untaint --all')).toEqual(STATE);
  });
});

// `<<<` is a here-string: one word handed to a command's input. `joinText` read its last two characters as the
// operator of a heredoc whose delimiter is that word, and folded every line after it into the line of the
// command, up to a delimiter that never came: the command on the next line was never read as one.
describe('a here-string is no heredoc', () => {
  it.each([
    'cat <<< hello\nstroq untaint --all',
    'grep x <<< "$y"\nstroq init',
    'cat <<<hello\nstroq uninstall',
    "read a <<< 'x y'\nstroq prove",
    'cat <<< a <<< b\nstroq untaint --all',
  ])('reads the line after %j', (command) => {
    expect(stroqStateSignals(command), command).toEqual(STATE);
  });

  it('reads a heredoc after a here-string as the heredoc it is', () => {
    expect(stroqStateSignals('cat <<< x; cat <<EOF\nbody\nEOF\nstroq untaint --all')).toEqual(
      STATE,
    );
    expect(stroqStateSignals('cat <<< x; cat <<EOF\nstroq untaint --all\nEOF')).toEqual([]);
  });
});
