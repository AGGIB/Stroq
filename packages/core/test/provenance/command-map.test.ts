import { describe, expect, it } from 'vitest';
import { commandMap } from '../../src/provenance/command-map.js';

// Where the commands of a command line are, as a shell reads them. A runner or installer that is
// the command word of a simple command is a command that will run; one inside quotes, a
// here-document or a comment, or among the arguments of another command, is a mention of one.

const WINDOW = 2048;
const wanted = (name: string): boolean => name === 'npx' || name === 'npm' || name === 'pip';
const starts = (text: string): number[] => [...commandMap(text, wanted, WINDOW).commands.keys()];
const at = (text: string, needle: string): number => text.indexOf(needle);

describe('a command in command position', () => {
  it.each([
    ['at the start', 'npx x'],
    ['after a semicolon', 'ls; npx x'],
    ['after &&', 'ls && npx x'],
    ['after ||', 'ls || npx x'],
    ['after a pipe', 'ls | npx x'],
    ['after &', 'ls & npx x'],
    ['after a line break', 'ls\nnpx x'],
    ['after a subshell opens', '(npx x)'],
    ['after a group opens', '{ npx x; }'],
    ['inside a command substitution', 'echo $(npx x)'],
    ['inside a command substitution in double quotes', 'echo "$(npx x)"'],
    ['inside backticks', 'echo `npx x`'],
    ['inside backticks in double quotes', 'git commit -m "run `npx x` now"'],
    ['after then', 'if true; then npx x; fi'],
    ['after do', 'for a in b; do npx x; done'],
    ['after a negation', '! npx x'],
    ['after an assignment', 'A=1 npx x'],
    ['after several assignments', 'A=1 B="two words" npx x'],
    ['after sudo', 'sudo npx x'],
    ['after sudo and an option with a value', 'sudo -u root npx x'],
    ['after env, its option and an assignment', 'env -i A=b npx x'],
    ['after time', 'time npx x'],
    ['after nice and its value', 'nice -n 5 npx x'],
    ['after timeout and a duration', 'timeout 5 npx x'],
    ['after nohup', 'nohup npx x'],
    ['after command', 'command npx x'],
    ['after xargs', 'xargs npx x'],
    ['after a wrapper and another', 'sudo env A=1 npx x'],
    ['after a continuation line', 'ls \\\n; npx x'],
    ['in the string a shell is given with -c', 'bash -c "npx x"'],
    ['in the string a shell is given with -lc', "sh -lc 'npx x'"],
    ['in the string eval is given', 'eval "npx x"'],
    ['in the string sudo hands a shell', "sudo bash -c 'npx x'"],
    ['as the second command of a pipeline in -c', 'bash -c "ls | npx x"'],
  ])('is found %s', (_what, text) => {
    expect(starts(text)).toContain(at(text, 'npx'));
  });
});

describe('a mention is not in command position', () => {
  it.each([
    ['an argument of echo', 'echo npx x'],
    ['a double-quoted argument', 'echo "npx x"'],
    ['a single-quoted argument', "echo 'npx x'"],
    ['a commit message', 'git commit -m "use npx x"'],
    ['a commit message in single quotes with a code span', "git commit -m 'use `npx x` now'"],
    ['an argument of grep', 'grep npx x'],
    ['a comment', '# npx x'],
    ['a comment after a command', 'ls # npx x'],
    ['an argument of cat', 'cat npx'],
    ['an unquoted here-document body', 'cat <<EOF\nnpx x\nEOF'],
    ['a quoted here-document body', "cat <<'EOF'\nnpx x\nEOF"],
    ['an indented here-document body', 'cat <<-EOF\n\tnpx x\n\tEOF'],
    ['a string given to a command that is no shell', 'ssh host "npx x"'],
    ['a string given to a shell without -c', 'bash "npx x"'],
    ['a word after a redirection', 'ls > npx'],
    ['a here-string', 'cat <<< "npx x"'],
    ['the name of a variable value', 'echo A=npx'],
  ])('%s', (_what, text) => {
    expect(starts(text)).not.toContain(at(text, 'npx'));
  });

  it('is found again after the here-document ends', () => {
    const text = 'cat <<EOF\nnpx x\nEOF\nnpx y';
    expect(starts(text)).toEqual([text.lastIndexOf('npx')]);
  });

  it('is found in a here-document that expands, where it is in a substitution', () => {
    const text = 'cat <<EOF\n$(npx x)\nEOF';
    expect(starts(text)).toContain(at(text, 'npx'));
  });
});

describe('where a command ends', () => {
  const endOf = (text: string, needle = 'npm'): number | undefined =>
    commandMap(text, wanted, WINDOW).commands.get(at(text, needle))?.end;

  it.each([
    ['a semicolon', 'npm i a; ls', 'npm i a'.length],
    ['&&', 'npm i a && ls', 'npm i a '.length],
    ['a pipe', 'npm i a | tail', 'npm i a '.length],
    ['a line break', 'npm i a\nls', 'npm i a'.length],
    ['the closing parenthesis of a subshell', '(npm i a)', '(npm i a'.length],
    ['a comment', 'npm i a # note; npm i b', 'npm i a '.length],
    ['the end of the text', 'npm i a', 'npm i a'.length],
    ['a closing backtick', '`npm i a`', '`npm i a'.length],
  ])('is %s', (_what, text, expected) => {
    expect(endOf(text)).toBe(expected);
  });

  it('is not a separator in quotes', () => {
    const text = 'npm i "a;b" "c && d" \'e | f\'; ls';
    expect(endOf(text)).toBe(text.indexOf('; ls'));
  });

  it('is not a separator after a backslash', () => {
    const text = 'npm i a\\;b c; ls';
    expect(endOf(text)).toBe(text.indexOf('; ls'));
  });

  it('is not a separator inside a substitution', () => {
    const text = 'npm i $(ls; ls) b; ls';
    expect(endOf(text)).toBe(text.lastIndexOf('; ls'));
  });
});

describe('the words of a command', () => {
  const wordsOf = (text: string): string[] => {
    const command = commandMap(text, wanted, WINDOW).commands.get(0);
    const words: string[] = [];
    for (let k = 0; k < (command?.words.length ?? 0); k += 2)
      words.push(text.slice(command?.words[k], command?.words[k + 1]));
    return words;
  };

  it('are split at blanks outside quotes only', () => {
    expect(wordsOf('npm i "a b" \'c d\' e\\ f g')).toEqual([
      'npm',
      'i',
      '"a b"',
      "'c d'",
      'e\\ f',
      'g',
    ]);
  });

  it('leave out the redirections and their targets', () => {
    expect(wordsOf('npm i a >out b 2>&1 c <in d &>all e >>log')).toEqual([
      'npm',
      'i',
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('keep a substitution whole, blanks and all', () => {
    expect(wordsOf('npm i a@$(echo 1 2) b')).toEqual(['npm', 'i', 'a@$(echo 1 2)', 'b']);
  });

  it('leave out a here-document opener and its delimiter', () => {
    expect(wordsOf('npm i a <<EOF b\nbody\nEOF')).toEqual(['npm', 'i', 'a', 'b']);
  });

  it('keep the words of a wrapped command', () => {
    expect(wordsOf('npm i \\\n  a \\\n  b')).toEqual(['npm', 'i', 'a', 'b']);
  });

  it('stop keeping words past the window, and say so', () => {
    const text = `npm i ${'a '.repeat(2000)}`;
    const command = commandMap(text, wanted, 100).commands.get(0);
    expect(command?.truncated).toBe(true);
    expect((command?.words.length ?? 0) / 2).toBeLessThan(60);
  });
});

describe('what the reading is not sure of', () => {
  it.each([
    ['a quote that never closes', 'echo "npx x'],
    ['a single quote that never closes', "echo 'npx x"],
    ['a substitution that never closes', 'echo $(npx x'],
    ['a backtick pair that never closes', 'echo `npx x'],
    ['a here-document that never ends', 'cat <<EOF\nnpx x'],
    ['an opener it cannot read', 'cat <<'],
  ])('is %s', (_what, text) => {
    expect(commandMap(text, wanted, WINDOW).uncertain).toBe(true);
  });

  it('is sure of ordinary commands', () => {
    for (const text of [
      'npm install a',
      'cat <<EOF\nx\nEOF',
      'echo "a $(ls) b" && ls',
      "git commit -m 'it is'",
      'a=$(npm i x)',
    ])
      expect(commandMap(text, wanted, WINDOW).uncertain, text).toBe(false);
  });

  it('says so for nesting past what it reads', () => {
    const text = `${'$('.repeat(60)}npx x${')'.repeat(60)}`;
    expect(commandMap(text, wanted, WINDOW).uncertain).toBe(true);
  });
});

describe('the cost of reading', () => {
  it('stays linear on long runs of constructs', () => {
    for (const unit of ['a;', '(', '"', "'", '$(', '`', '\\\n', '<<EOF\n', 'npm i a ', '#']) {
      const text = unit.repeat(40_000);
      const started = performance.now();
      commandMap(text, wanted, WINDOW);
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(400);
    }
  });
});
