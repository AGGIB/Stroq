import { describe, expect, it } from 'vitest';
import { extractActionAtoms } from '../../src/provenance/atoms.js';
import { matchCommand } from '../../src/provenance/command-match.js';

// The options between a tool and its verb are the tool's own: `-w` takes a workspace in npm and
// takes nothing in pnpm, and an option is compared as it is written. Where the words cannot be
// matched with certainty (an option nobody knows, a value that is also a verb, more options than
// are looked at, an interpreter flag nobody knows), the command is a doubt and the packages in it
// are still read; it is never decided that a command is no launcher while a verb of the tool
// stands further on.

const NAME = 'evil-helper-fix';
const pkg = { kind: 'pkg', value: NAME };
const read = (command: string) => extractActionAtoms(command);
const packages = (command: string): string[] =>
  read(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

describe('the options of each tool, as written', () => {
  it.each([
    [`npm -w web i ${NAME}`, 'npm takes a workspace'],
    [`npm --workspace web install ${NAME}`, 'npm takes a workspace'],
    [`pnpm -w add ${NAME}`, 'pnpm takes none for -w'],
    [`pnpm -C app add ${NAME}`, 'pnpm takes a directory for -C'],
    [`pnpm -F app add ${NAME}`, 'pnpm takes a filter for -F'],
    [`yarn --cwd app add ${NAME}`, 'yarn takes a directory'],
    [`bun --cwd app add ${NAME}`, 'bun takes a directory'],
    [`cargo -Z unstable-options install ${NAME}`, 'cargo takes a flag for -Z'],
    [`cargo --config build.jobs=2 install ${NAME}`, 'cargo takes a setting'],
    [`pip --python /usr/bin/python3 install ${NAME}`, 'pip takes an interpreter'],
    [`pip --retries 3 install ${NAME}`, 'pip takes a count'],
    [`poetry -C app add ${NAME}`, 'poetry takes a directory'],
    [`go -C app install ${NAME}`, 'go takes a directory'],
  ])('%s (%s)', (command) => {
    expect(packages(command)).toContain(NAME);
    expect(read(command).unread).toBe(false);
  });

  it('does not let one tool borrow the options of another', () => {
    // `-w` takes no value in pnpm: the word after it is the verb, not the value of the option.
    expect(packages(`pnpm -w add ${NAME}`)).toEqual([NAME]);
    // `-C` is not an npm option, and what follows it is read as a doubt, with the verb found.
    const odd = read(`npm -C app install ${NAME}`);
    expect(odd.atoms).toContainEqual(pkg);
    expect(odd.unread).toBe(true);
  });

  it('compares an option as it is written', () => {
    // `-c` is not `-C`: the lower-case one takes no value in pnpm.
    const odd = read(`pnpm -c app add ${NAME}`);
    expect(odd.atoms).toContainEqual(pkg);
    expect(odd.unread).toBe(true);
  });
});

describe('a value that is also a verb', () => {
  it.each([
    `npm -w install install ${NAME}`,
    `npm --prefix add add ${NAME}`,
    `yarn --cwd add add ${NAME}`,
    `pnpm -C install install ${NAME}`,
  ])('is read as the verb and as a value, and is a doubt: %s', (command) => {
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
    expect(result.unreadCause).toBe('name');
  });
});

describe('a word that is not a verb, with a verb further on', () => {
  it.each([
    `npm --some-new-flag value install ${NAME}`,
    `npm --some-new-flag one two install ${NAME}`,
    `pip somecommand install ${NAME}`,
    `cargo +nightly build install ${NAME}`,
  ])('is a doubt, and the packages after the verb are read: %s', (command) => {
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
  });

  it.each([
    'npm run build',
    'npm test',
    'pip list',
    'pip freeze > out.txt',
    'cargo build --release',
    'yarn build',
    'pnpm run lint -- --fix',
    'go test ./...',
  ])('is no launcher when no verb stands after it: %s', (command) => {
    expect(read(command).atoms.filter((a) => a.kind === 'pkg')).toEqual([]);
    expect(read(command).unread).toBe(false);
  });

  it('is no doubt when the words are a mention', () => {
    expect(read(`echo "npm somecommand install ${NAME}"`).unread).toBe(false);
  });
});

describe('more options than are looked at', () => {
  it('is a doubt, never the answer that the command is no launcher', () => {
    const command = `npm ${'--a '.repeat(100)}install ${NAME}`;
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
  });

  it('is a doubt for a Python command with many flags before -m', () => {
    const command = `python ${'-u '.repeat(100)}-m pip install ${NAME}`;
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
  });
});

describe('the flags of a Python interpreter before -m', () => {
  it.each([
    `python -m pip install ${NAME}`,
    `python -u -m pip install ${NAME}`,
    `python -B -E -s -S -I -O -OO -q -v -b -bb -R -x -m pip install ${NAME}`,
    `python -uB -m pip install ${NAME}`,
    `python -W ignore -m pip install ${NAME}`,
    `python -Wignore -m pip install ${NAME}`,
    `python -X dev -m pip install ${NAME}`,
    `python -Xdev -m pip install ${NAME}`,
    `python3 -mpip install ${NAME}`,
    `python3.11 -u -m pip install ${NAME}`,
    `python3 -m pip --quiet install ${NAME}`,
    `py -3 -m pip install ${NAME}`,
    `py -3.11 -m pip install ${NAME}`,
    `py -3 -u -m pip install ${NAME}`,
    `uv run python -m pip install ${NAME}`,
    `uv run --with requests python3 -m pip install ${NAME}`,
    `uv run python3.12 -u -m pip --quiet install ${NAME}`,
    `sudo python3 -m pip install ${NAME}`,
  ])('are passed over: %s', (command) => {
    expect(packages(command)).toContain(NAME);
    expect(read(command).unread).toBe(false);
  });

  it.each([
    `python --weird -m pip install ${NAME}`,
    `python -Q -m pip install ${NAME}`,
    `py -9x -m pip install ${NAME}`,
    `python script.py -m pip install ${NAME}`,
  ])('are a doubt when one is unknown, or -m comes after a script: %s', (command) => {
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
  });

  it.each([
    'python script.py',
    'python -c "print(1)"',
    'python -m venv .venv',
    'python -m pytest tests',
    'python3 manage.py migrate',
    'uv run pytest',
    'uv run python script.py',
  ])('is no launcher: %s', (command) => {
    expect(read(command).atoms.filter((a) => a.kind === 'pkg')).toEqual([]);
    expect(read(command).unread).toBe(false);
  });
});

describe('the short-option clusters of a Python interpreter, as CPython reads them', () => {
  it.each([
    `python -um pip install ${NAME}`,
    `python -Bm pip install ${NAME}`,
    `python -uBm pip install ${NAME}`,
    `python3 -mpip install ${NAME}`,
    `python3 -umpip install ${NAME}`,
    `python -Wignore -m pip install ${NAME}`,
    `python -W ignore -um pip install ${NAME}`,
    `python -Xdev -Bm pip install ${NAME}`,
    `py -3 -um pip install ${NAME}`,
  ])('runs the module after the letters before the m: %s', (command) => {
    expect(packages(command)).toContain(NAME);
    expect(read(command).unread).toBe(false);
  });

  it('is not a module run when a letter says the next word is code', () => {
    const command = ['python', '-c', "'import x'", 'pip', 'install', NAME];
    expect(matchCommand(command)).toBeNull();
    expect(matchCommand(['python', '-uc', "'import x'", 'pip', 'install', NAME])).toBeNull();
    expect(matchCommand(['python', '-Wignore', '-c', 'code', 'pip', 'install', NAME])).toBeNull();
  });

  it('leaves what a code string mentions as a mention', () => {
    // The text `pip install x` after code is an argument of the program, read as a mention.
    const result = read(`python -c 'import x' pip install ${NAME}`);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(false);
  });

  it.each([
    `python -Zm pip install ${NAME}`,
    `python -u -Z thing -m pip install ${NAME}`,
    `python --weird thing -m pip install ${NAME}`,
  ])('is a doubt when a flag nobody knows comes first: %s', (command) => {
    const result = read(command);
    expect(result.atoms).toContainEqual(pkg);
    expect(result.unread).toBe(true);
  });
});

describe('the options of one tool are not the options of another', () => {
  it.each([
    'cargo install --path $PWD',
    'cargo install --root $HOME/tools foo',
    'cargo install --git https://example.test/x.git --branch $B foo',
    'cargo install --rev $R --bin $BIN foo',
    'cargo install --features $F foo',
    'uv add --git https://example.test/x.git --branch main foo',
    'uv add --rev $R --tag $T foo',
    'pip install --root $ROOT foo',
    'pip install -e $DIR',
    'gem install foo -v "~> 2.4"',
  ])('is skipped where the tool has it: %s', (command) => {
    expect(read(command).unread).toBe(false);
  });

  it.each([
    'npm install --path $X',
    'npm install --root $X foo',
    'pnpm add --bin $B foo',
    'yarn add --features $F foo',
    'pip install --git $X',
    'pip install --branch $B foo',
    'gem install --branch $B foo',
    'bun add --rev $R foo',
  ])('is a package word where the tool does not have it: %s', (command) => {
    expect(read(command).unread).toBe(true);
  });
});
