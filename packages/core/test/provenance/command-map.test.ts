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
    ['an eval, with its string', 'eval "npx x"'],
    ['an eval, with words', 'eval npx x'],
    ['a -c that is not one quoted string', 'bash -c npx x'],
    ['a -c with a variable', 'bash -c $CMD'],
    ['a -c with --', 'sh -c -- "npx x"'],
    ['a -c with two strings that are one word', 'bash -c "npx x"" y"'],
    ['a pipe into a shell', 'echo hi | bash'],
    ['a pipe into a shell by path', 'echo hi | /bin/bash'],
    ['a pipe into a shell behind a line break', 'echo hi |\n sh'],
    ['a here-document into a shell', 'bash <<EOF\nnpx x\nEOF'],
    ['a here-string into a shell', 'bash <<< "npx x"'],
    ['su with -c', 'su -c "npx x" root'],
    ['runuser with -c', 'runuser -c "npx x" bob'],
    ['busybox with -c', 'busybox sh -c "npx x"'],
    ['ssh with -c', 'ssh -c aes128-ctr host ls'],
    ['watch', 'watch -n 5 npx x'],
    ['parallel', 'parallel npx ::: x'],
    ['script', 'script -c "npx x" out'],
    ['env -S', 'env -S "npx x"'],
    ['find -exec', 'find . -exec npx x \\;'],
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

// A mention is inert only by a closed and tiny rule: the message of `git commit`, `git tag` or
// `git notes add`, the arguments of `echo` and `printf`, a line that is only a comment, on a line
// that has no pipe, redirection, substitution, group, condition or string-running word anywhere.
describe('what a line proves inert', () => {
  const mentionsOf = (text: string): number[] =>
    [...text.matchAll(/npx|npm install/g)].map((m) => m.index ?? 0);
  const inertOf = (text: string): boolean[] => {
    const mentions = mentionsOf(text);
    const { inert } = commandMap(text, wanted, WINDOW, mentions);
    return mentions.map((index) => inert.has(index));
  };

  it.each([
    ['a commit message', 'git commit -m "npx x"'],
    ['a commit message with -am', 'git commit -am "npx x"'],
    ['a commit message in single quotes', "git commit -m 'npm install x'"],
    ['a tag message', 'git tag -a v1 -m "npx x"'],
    ['a note', 'git notes add -m "npx x"'],
    ['a commit message under an option with a value', 'git -C app commit -m "npx x"'],
    ['a message from a here-document', 'git commit -F - <<EOF\nnpx x\nEOF'],
    ['an echo', 'echo "npx x"'],
    ['an echo with words', 'echo run npx x now'],
    ['a printf', "printf '%s\\n' 'npm install x'"],
    ['a comment line', '# npx x'],
    ['a comment line after a line that does nothing', 'true\n  # npx x'],
    ['a commit message after commands that do nothing', 'true; : ; git commit -m "npm install x"'],
    ['an echo after an echo', 'echo a; echo "npx x"'],
    ['an echo and a printf', 'printf \'%s\' a && echo "npx x"'],
    ['two commit messages', 'git commit -m a && git tag -m "npx x" v1'],
  ])('is inert in %s', (_what, text) => {
    expect(inertOf(text).every(Boolean)).toBe(true);
    expect(inertOf(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['a cat', 'cat <<EOF\nnpx x\nEOF'],
    ['a here-string', 'cat <<< "npx x"'],
    ['a tee', 'tee notes <<EOF\nnpx x\nEOF'],
    ['a grep', 'grep "npx x" f'],
    ['a pull request body', 'gh pr create --body "npx x"'],
    ['a log search', 'git log --grep="npx x"'],
    ['a comment after a command', 'ls # npx x'],
    ['an argument of a command that is not known', 'foo "npx x"'],
    ['an ssh', 'ssh host "npx x"'],
    ['a git message that is not the one after -m', 'git commit -m ok "npx x"'],
    ['a message of git status', 'git status "npx x"'],
    ['a message under sudo', 'sudo git commit -m "npx x"'],
    ['a message after an assignment', 'A=1 git commit -m "npx x"'],
    ['an echo under env', 'env echo "npx x"'],
  ])('is not inert in %s', (_what, text) => {
    expect(inertOf(text).some(Boolean)).toBe(false);
  });

  // Deny by default for the whole line: any command on it that is not in the closed set clears it.
  it.each([
    ['export', 'export A=1; echo "npx x"'],
    ['declare', 'declare -f f; echo "npx x"'],
    ['typeset', 'typeset -f f; echo "npx x"'],
    ['readonly', 'readonly A=1; echo "npx x"'],
    ['set', 'set -e; echo "npx x"'],
    ['trap', 'trap ls EXIT; echo "npx x"'],
    ['alias', 'alias echo=ls; echo "npx x"'],
    ['hash', 'hash -p /x/ls ls; echo "npx x"'],
    ['enable', 'enable -f x y; echo "npx x"'],
    ['shopt', 'shopt -s expand_aliases; echo "npx x"'],
    ['read', 'read -r v; echo "npx x"'],
    ['mapfile', 'mapfile -t a < f; echo "npx x"'],
    ['printf -v', 'printf -v out "%s" x; echo "npx x"'],
    ['printf -v glued', 'printf -vout "%s" x; echo "npx x"'],
    ['git config', 'git config core.pager x; git commit -m "npx x"'],
    ['git config before an echo', 'git config alias.ci commit; echo "npx x"'],
    ['git status', 'git status; echo "npx x"'],
    ['git push', 'git push; git commit -m "npx x"'],
    ['git add', 'git add .; git commit -m "npx x"'],
    ['git log', 'git log; echo "npx x"'],
    ['git commit with an editor', 'git commit -e -m "npx x"'],
    ['git commit with --edit', 'git commit --edit -m "npx x"'],
    ['git commit with a cluster that edits', 'git commit -ae -m "npx x"'],
    ['git commit -c', 'git commit -c HEAD -m "npx x"'],
    ['git tag with an editor', 'git tag -e -a v1 -m "npx x"'],
    ['a dynamic command', '$CMD x; echo "npx x"'],
    ['a braced dynamic command', '${CMD} x; echo "npx x"'],
    ['a quoted dynamic command', '"$CMD" x; echo "npx x"'],
    ['a dynamic command from a substitution', 'echo "npx x"; $(which ls)'],
    ['a function definition', 'f() { :; }; echo "npx x"'],
    ['a function keyword', 'function f { :; }; echo "npx x"'],
    ['an assignment of GIT_PAGER', 'GIT_PAGER=ls; echo "npx x"'],
    ['an assignment of GIT_EDITOR', 'GIT_EDITOR=ls git commit -m "npx x"'],
    ['an assignment of GIT_SSH_COMMAND', 'GIT_SSH_COMMAND=ls; echo "npx x"'],
    ['an assignment of EDITOR', 'EDITOR=ls; git commit -e -m "npx x"'],
    ['an assignment of VISUAL', 'VISUAL=ls; echo "npx x"'],
    ['an assignment of PAGER', 'PAGER=ls; echo "npx x"'],
    ['an assignment of PAGER with +=', 'PAGER+=ls; echo "npx x"'],
    ['another command', 'ls; echo "npx x"'],
    ['cat', 'cat f; echo "npx x"'],
    ['a wrapper', 'sudo ls; echo "npx x"'],
    ['env', 'env ls; echo "npx x"'],
    ['time', 'time ls; echo "npx x"'],
    ['source', 'source f; echo "npx x"'],
    ['a dot', '. f; echo "npx x"'],
    ['exec', 'exec ls; echo "npx x"'],
    ['command', 'command ls; echo "npx x"'],
    ['a test', 'test 1 -eq 1; echo "npx x"'],
    ['a double bracket', '[[ -f f ]]; echo "npx x"'],
    ['a find', 'find . -name x; echo "npx x"'],
    ['a make', 'make; echo "npx x"'],
  ])('is not inert when the line holds %s', (_what, text) => {
    expect(inertOf(text).some(Boolean)).toBe(false);
  });

  it.each([
    ['a pipe', 'echo "npx x" | cat'],
    ['a pipe into a shell', 'echo "npx x" | sh'],
    ['a pipe elsewhere on the line', 'ls | wc; echo "npx x"'],
    ['an output redirection', 'echo "npx x" > f'],
    ['an append', 'echo "npx x" >> f'],
    ['an input redirection elsewhere', 'echo "npx x"; cat < f'],
    ['a stderr redirection', 'git commit -m "npx x" 2>&1'],
    ['a process substitution', 'echo "npx x"; diff <(ls) f'],
    ['a command substitution', 'echo "npx x" $(date)'],
    ['a command substitution elsewhere', 'git commit -m "npx x"; echo $(date)'],
    ['a backtick', 'git commit -m "npx x"; echo `date`'],
    ['an eval', 'git commit -m "npx x"; eval ls'],
    ['a source', 'echo "npx x"; source f'],
    ['a dot', 'echo "npx x"; . f'],
    ['an xargs', 'echo "npx x"; xargs ls'],
    ['a shell', 'echo "npx x"; bash f'],
    ['a shell with -c', 'echo "npx x"; sh -c ls'],
    ['an ssh', 'echo "npx x"; ssh host ls'],
    ['an su', 'echo "npx x"; su root'],
    ['a watch', 'echo "npx x"; watch ls'],
    ['a function', 'f() { echo "npx x"; }'],
    ['a group', '{ echo "npx x"; }'],
    ['a subshell', '(echo "npx x")'],
    ['a condition', 'if echo "npx x"; then ls; fi'],
    ['a loop', 'for i in 1; do echo "npx x"; done'],
    ['a while', 'while echo "npx x"; do ls; done'],
    ['a case', 'case x in x) echo "npx x";; esac'],
    ['a setting of git that names a command', 'git -c core.pager=\'sh -c x\' commit -m "npx x"'],
    ['a config-env option of git', 'git --config-env=core.pager=P commit -m "npx x"'],
    ['a setting of git on another command of the line', 'git -c a=b status; echo "npx x"'],
    ['a here-document given to something that is not git', 'cat <<EOF\nx\nEOF\necho "npx x"'],
  ])('is not inert when the line holds %s', (_what, text) => {
    expect(inertOf(text).some(Boolean)).toBe(false);
  });
});
