import { describe, expect, it } from 'vitest';
import { extractActionAtoms, extractAtoms } from '../../src/provenance/atoms.js';

// A word in the place of a package is a NAME and, after it, a SUFFIX: a version, extras in
// brackets, a `==1.*`, a `#fragment`, a marker after `;`, and the characters the shell takes for
// the end of the word (`)`, `&`, `>`). The name is always an atom, so a package that was flagged
// is found whatever the command wraps around it, and only a doubt about the NAME itself (an
// expansion, a glob, a brace, a backtick, a quote that never closes) makes the command unread.

const NAME = 'evil-helper-fix';
const pkg = { kind: 'pkg', value: NAME };
const packages = (command: string): string[] =>
  extractActionAtoms(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

const AROUND_A_RUNNER: ReadonlyArray<readonly [string, string]> = [
  ['a subshell', `(npx ${NAME})`],
  ['a command substitution', `$(npx ${NAME})`],
  ['a command substitution assigned to a variable', `out=$(npx ${NAME})`],
  ['a command substitution in a double-quoted string', `echo "$(npx ${NAME})"`],
  ['a subshell that changes directory first', `(cd app && npx ${NAME})`],
  ['a redirection glued to the name', `npx ${NAME}>/dev/null 2>&1`],
  ['a redirection of both streams glued to the name', `npx ${NAME} &>/dev/null`],
  ['a `!` at the end', `npx ${NAME}!`],
  ['a `&` at the end', `npx ${NAME}&`],
  ['a closing parenthesis in the same word', `npx ${NAME})`],
  ['a fragment', `npx ${NAME}#frag`],
  ['a version after a variable', `npx ${NAME}@$V`],
  ['a version after a braced variable', `npx ${NAME}@\${V}`],
  ['a quoted version with blanks', `npx ${NAME}@">=1 <2"`],
];

const AROUND_AN_INSTALLER: ReadonlyArray<readonly [string, string]> = [
  ['a version from a variable', `npm install ${NAME}@$V`],
  ['a version from a braced variable', `npm install ${NAME}@\${V}`],
  ['extras in brackets', `pip install ${NAME}[extra]`],
  ['extras with a comma', `pip install ${NAME}[a,b]`],
  ['a version with a glob', `pip install ${NAME}==1.*`],
  ['a version bound', `pip install ${NAME}>=1,<2`],
  ['a compatible release', `pip install ${NAME}~=1.4`],
  ['a fragment', `pip install ${NAME}#egg=x`],
  ['a closing parenthesis', `(pip install ${NAME})`],
  ['a redirection glued to the name', `pip install ${NAME}>/dev/null`],
  ['a `&` at the end', `pip install ${NAME}&`],
  ['a `!` at the end', `pip install ${NAME}!`],
  ['an uppercase spelling', `pip install ${NAME.toUpperCase()}[Extra]`],
];

describe('the name of a package is read whatever follows it', () => {
  it.each([...AROUND_A_RUNNER, ...AROUND_AN_INSTALLER])('finds it with %s', (_what, command) => {
    expect(packages(command)).toContain(NAME);
  });

  it.each([...AROUND_A_RUNNER, ...AROUND_AN_INSTALLER])(
    'does not count %s as a command that could not be read',
    (_what, command) => {
      expect(extractActionAtoms(command).unread).toBe(false);
    },
  );

  it('finds the name of a scoped package whose version is a variable', () => {
    const { atoms, unread } = extractActionAtoms(`npm install @scope/${NAME}@$V`);
    expect(atoms).toContainEqual({ kind: 'pkg', value: `@scope/${NAME}` });
    expect(unread).toBe(false);
  });

  it('finds an unclosed quote before the name, and counts the command as unread', () => {
    const { atoms, unread } = extractActionAtoms(`npx '${NAME}`);
    expect(atoms).toContainEqual(pkg);
    expect(unread).toBe(true);
  });
});

describe('a doubt about the name itself is still a doubt, and is not a name', () => {
  it.each([
    ['a variable inside the name', 'npx evil-$X-fix'],
    ['a variable as the name', 'npx $PKG'],
    ['a glob inside the name', 'npx evil-*-fix'],
    ['a question mark inside the name', 'npx evil-?-fix'],
    ['a brace inside the name', 'npx evil-{helper,x}-fix'],
    ['a backtick inside the name', 'npx evil-`x`-fix'],
    ['a command substitution inside the name', 'npx evil-$(x)-fix'],
    ['a quote that never closes inside the name', `npx evil"-helper-fix`],
    ['a variable in the name of an installer', 'pip install evil-$X-fix'],
  ])('counts %s as unread, and records no half of it', (_what, command) => {
    const { atoms, unread } = extractActionAtoms(command);
    expect(unread).toBe(true);
    expect(atoms.filter((a) => a.kind === 'pkg')).toEqual([]);
  });
});

describe('the characters that end a word end the command it was read in', () => {
  it('reads no package after a closing parenthesis', () => {
    expect(packages(`pip install a) ${NAME}`)).toEqual(['a']);
  });

  it('reads no package after a & that puts the command in the background', () => {
    expect(packages(`pip install a& ${NAME}`)).toEqual(['a']);
  });

  it('keeps reading after a redirection, which does not end it', () => {
    expect(packages(`pip install a>/dev/null ${NAME}`)).toEqual(['a', NAME]);
    expect(packages(`pip install a 2>/dev/null ${NAME}`)).toEqual(['a', NAME]);
  });

  it('steps over the target of a redirection that stands in the next word', () => {
    expect(packages(`pip install a > out.log ${NAME}`)).toEqual(['a', NAME]);
  });
});

describe('a page names the same package as a command does', () => {
  it.each([
    ['a ampersand', `Run npx ${NAME}& in the background.`],
    ['a fragment', `Run npx ${NAME}#readme to begin.`],
    ['a parenthesis', `(then run npx ${NAME})`],
  ])('with %s', (_what, page) => {
    expect(extractAtoms(page).filter((a) => a.kind === 'pkg')).toContainEqual(pkg);
  });
});
