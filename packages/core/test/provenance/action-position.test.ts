import { describe, expect, it } from 'vitest';
import { readActionAtoms } from '../../src/provenance/action-atoms.js';
import { extractActionAtoms } from '../../src/provenance/atoms.js';
import { DEFAULT_MAX_CHARS } from '../../src/scan/scanner.js';

// The doubt about a package name (a word the shell expands where a package should stand) belongs
// to a runner or installer that will run: one that stands in command position. A mention of one
// in a quoted string, a here-document or a comment is read for the package it names, and is no
// doubt. A tool that is not a shell has no commands, only text.

const NAME = 'evil-helper-fix';
const pkg = { kind: 'pkg', value: NAME };

describe('a runner or installer that will run, with a name nobody can read', () => {
  it.each([
    ['at the start', 'npx $PKG'],
    ['of an installer', 'npm install ev$X'],
    ['after an assignment', 'A=1 npx ev$X'],
    ['after sudo', 'sudo npx ev$X'],
    ['after env', 'env FOO=1 npm i ev*l'],
    ['after nohup, in the background', 'nohup npx $X &'],
    ['after xargs', 'xargs npx $X'],
    ['after time', 'time npx $X'],
    ['after &&', 'ls && npx $X'],
    ['after a semicolon', 'ls; npm install $X'],
    ['in a subshell', '(npx $X)'],
    ['after then', 'if true; then npx $X; fi'],
    ['in a command substitution', 'echo $(npx $X)'],
    ['in a command substitution in double quotes', 'echo "$(npx $X)"'],
    ['in backticks', 'echo `npx $X`'],
    ['in the string given to bash -c', 'bash -c "npx $X"'],
    ['in the string given to sh -c', "sh -c 'npm install $X'"],
    ['in the string given to eval', 'eval "npx $X"'],
    ['in the string given to a login shell under sudo', "sudo bash -lc 'npx $X'"],
    ['in the string given to ssh', 'ssh host "npx $X"'],
    ['in an argument of a command that is not known to run none of it', 'foo "npm install $X"'],
    ['in code given to an interpreter', 'python3 -c "import os; os.system(\'npm i $X\')"'],
    ['in the value of an assignment', 'A="npm install $X"'],
    ['in a string given to make', 'make "npx $X"'],
    ['in a string given to env', 'env "npx $X"'],
    ['in a string given to watch', "watch 'npx $X'"],
    ['in a string given to su', 'su -c "npx $X" root'],
    ['after eval', 'eval "npx $X"'],
    ['after eval without quotes', 'eval npx $X'],
    ['in a -c that is not one quoted string', 'bash -c npx $X'],
    ['in a -c after --', 'bash -c -- "npx $X"'],
    ['in a pipe into a shell', 'cat <<EOF | bash\nnpx $X\nEOF'],
    ['in a here-document into a shell', 'bash <<EOF\nnpm install $X\nEOF'],
    ['in a here-string into a shell', 'bash <<< "npx $X"'],
    ['under watch', 'watch -n 5 npx $X'],
    ['under parallel', 'parallel npx $X ::: a'],
    ['under find -exec', 'find . -exec npx $X \\;'],
    ['under env -S', 'env -S "npx $X"'],
    ['under a path-qualified env', '/usr/bin/env FOO=1 npx $X'],
    ['in the string of a path-qualified shell', '/bin/bash -c "npx $X"'],
    ['in the string of a shell under a path-qualified env', '/usr/bin/env bash -c "npx $X"'],
  ])('is unread %s', (_what, command) => {
    const read = extractActionAtoms(command);
    expect(read.unread).toBe(true);
    expect(read.unreadCause).toBe('name');
  });
});

describe('a mention of a runner or installer, with a name nobody can read', () => {
  it.each([
    ['a commit message', 'git commit -m "npm install foo$X"'],
    ['a commit message that says npx', 'git commit -m "docs: use npx $PKG"'],
    ['an echo', "echo 'run npx $X'"],
    ['an echo with a glob', 'echo "npm install a*b"'],
    ['a printf', 'printf \'%s\\n\' "pip install ev*l"'],
    ['a here-document that expands', 'cat <<EOF\nnpm install ev$X\nEOF'],
    ['a quoted here-document', "cat <<'EOF'\nnpx $PKG\nEOF"],
    ['a here-document written to a file', 'cat > notes.md <<EOF\nnpx $X\nEOF'],
    ['a comment', '# npm install $X'],
    ['a comment after a command', 'ls # npx $X'],
    ['a code span in a commit message', "git commit -m 'use `npx $X` now'"],
    ['the argument of grep', 'grep "npx $X" README.md'],
    ['a tag message', 'git tag -a v1 -m "npm install $X"'],
    ['a pull request body', 'gh pr create --body "npx $X"'],
    ['an issue comment', 'gh issue comment 1 --body "npm i $X"'],
    ['a git log search', 'git log --grep="npm i $X"'],
    ['a message from a here-document', 'git commit -F - <<EOF\nnpx $X\nEOF'],
    ['a note written with tee', 'tee notes.md <<EOF\nnpm i $X\nEOF'],
    ['a here-string given to cat', 'cat <<< "npx $X"'],
    ['git with a directory', 'git -C app commit -m "npx $X"'],
    ['a commit message under sudo', 'sudo git commit -m "npx $X"'],
  ])('is no doubt in %s', (_what, command) => {
    const read = extractActionAtoms(command);
    expect(read.unread).toBe(false);
    expect(read.unreadCause).toBeNull();
  });

  it.each([
    `git commit -m "npx ${NAME}"`,
    `echo 'run npm install ${NAME} now'`,
    `cat <<EOF\nnpx ${NAME}\nEOF`,
    `cat <<'EOF'\npip install ${NAME}\nEOF`,
    `# npx ${NAME}`,
  ])('still names the package, so that a flagged one is found: %s', (command) => {
    expect(extractActionAtoms(command).atoms).toContainEqual(pkg);
  });
});

describe('the ordinary shapes of a command are not asked about', () => {
  it.each([
    'pip install -e .[dev]',
    'pip install .[test]',
    'uv pip install -e .[dev]',
    'pip install requests[socks]',
    'pip install "pkg >= 1"',
    'gem install x -v "~> 2.4"',
    `pip install "foo; python_version<'3.9'"`,
    'npm i foo@">=1 <2"',
    'npm i user/repo#ref',
    'npm install github:u/r#main',
    'pip install git+https://github.com/u/r.git#egg=x',
    'pip install foo # comment',
    'pip install -e ~/dev/lib',
    'cargo install --path $PWD',
    'npm install -g typescript@$VER',
    "npx -c 'echo $HOME'",
    'npx --yes create-thing@latest my-app',
    'pip install -r requirements.txt',
    'npm install foo 2>&1 | tail -5',
    'npm install foo > /tmp/out.txt 2>&1',
  ])('%s', (command) => {
    const read = extractActionAtoms(command);
    expect(read.unread).toBe(false);
  });
});

describe('a quoted spec with blanks or a separator is one word', () => {
  it.each([
    ['a blank in double quotes', `pip install "${NAME} >= 1"`],
    ['a semicolon in double quotes', `pip install "${NAME}; python_version<'3.9'"`],
    ['a version range in quotes', `npm i ${NAME}@">=1 <2"`],
    ['a pipe in quotes', `pip install "${NAME}|x"`],
    ['an ampersand in quotes', `pip install "${NAME}&x"`],
  ])('names the package after %s', (_what, command) => {
    const read = extractActionAtoms(command);
    expect(read.atoms).toContainEqual(pkg);
    expect(read.unread).toBe(false);
  });

  it('keeps reading the packages after a quoted separator', () => {
    const names = extractActionAtoms(`pip install "a;b" ${NAME}`).atoms.map((a) => a.value);
    expect(names).toContain(NAME);
  });
});

describe('a word that opens a quote the line never closes', () => {
  it.each([
    ['a single quote before the name', `npm install 'a ${NAME}`],
    ['a double quote and a parenthesis', `npm install "a) ${NAME}`],
    ['a double quote and an ampersand', `npm install "a & ${NAME}`],
  ])('is unread, and a package after it is still named: %s', (_what, command) => {
    const read = extractActionAtoms(command);
    expect(read.unread).toBe(true);
    expect(read.atoms).toContainEqual(pkg);
  });

  it('is unread when a semicolon in what it opens would have ended the line', () => {
    expect(extractActionAtoms(`npx "a ; ${NAME}`).unread).toBe(true);
  });

  it.each([
    ['single quotes', `npm install 'a b' ${NAME}`],
    ['double quotes', `npm install "a b" ${NAME}`],
    ['a closed quote and a plain closer', `npm install 'a b'; ${NAME}`],
  ])(
    'with the quote closed (%s) reads on past it, and a real closer ends the command',
    (what, command) => {
      const names = extractActionAtoms(command).atoms.map((a) => a.value);
      if (what === 'a closed quote and a plain closer') expect(names).not.toContain(NAME);
      else expect(names).toContain(NAME);
    },
  );
});

describe('a command longer than the text that is read', () => {
  const filler = (length: number): string => 'echo hello world\n'.repeat(Math.ceil(length / 17));

  it.each([
    ['holding nothing that launches', filler(DEFAULT_MAX_CHARS + 50_000)],
    [
      'with an installer past the cut',
      `${filler(DEFAULT_MAX_CHARS + 50_000)}npm install somewhere`,
    ],
    ['with a runner past the cut', `${filler(DEFAULT_MAX_CHARS + 50_000)}npx somewhere`],
  ])('is unread for its length, %s', (_what, command) => {
    const read = extractActionAtoms(command);
    expect(read.unread).toBe(true);
    expect(read.unreadCause).toBe('length');
  });

  it('is not unread at the characters that are read', () => {
    expect(
      extractActionAtoms(filler(DEFAULT_MAX_CHARS - 20).slice(0, DEFAULT_MAX_CHARS)).unread,
    ).toBe(false);
  });

  it('names a cause of length when a line runs past the window', () => {
    const read = extractActionAtoms(`npx ${'-y '.repeat(1200)}${NAME}`);
    expect(read.unread).toBe(true);
    expect(read.unreadCause).toBe('length');
  });

  it('puts the length before the name when both hold', () => {
    const read = extractActionAtoms(`npx $X\n${'echo x\n'.repeat(30_000)}npm i later`);
    expect(read.unreadCause).toBe('length');
  });
});

describe('what is not a shell has no commands', () => {
  it('reads the text of an MCP call as text, with no doubt about a name', () => {
    const body = 'Run npm install ev$X and then `npx $PKG` or pip install a*b';
    const read = extractActionAtoms(body, false);
    expect(read.unread).toBe(false);
    expect(read.unreadCause).toBeNull();
  });

  it('still names the package in it', () => {
    expect(extractActionAtoms(`Run npx ${NAME} now`, false).atoms).toContainEqual(pkg);
  });

  it('reads an MCP call this way, and a shell tool the other way', () => {
    const input = { body: 'npm install ev$X' };
    expect(readActionAtoms('mcp__github__create_pull_request', input, '/nonexistent').unread).toBe(
      false,
    );
    expect(readActionAtoms('Bash', { command: 'npm install ev$X' }, '/nonexistent').unread).toBe(
      true,
    );
  });
});
