import { describe, expect, it } from 'vitest';
import { withKnownVariables } from '../../src/actions/known-variables.js';
import { lex } from '../../src/actions/shell-lex.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const LIMIT = 1_000_000;
const variants = (text: string): string[] => withKnownVariables(text, lex(text), LIMIT);
const variant = (text: string): string | null => variants(text)[0] ?? null;

describe('withKnownVariables: the command as the shell expands the variables it sets', () => {
  it.each<[string, string]>([
    ['x=rm; $x -rf ~', 'x=rm; rm -rf ~'],
    ['a=r; b=m; $a$b -rf ~', 'a=r; b=m; rm -rf ~'],
    ['x=rm; ${x} -rf ~', 'x=rm; rm -rf ~'],
    ['x=rm\n$x -rf ~', 'x=rm\nrm -rf ~'],
    ['f=x.sh; cat "$f" | bash', 'f=x.sh; cat "x.sh" | bash'],
    ['d=~; rm -rf $d', 'd=~; rm -rf ~'],
    ['export T=/tmp/x; cd $T', 'export T=/tmp/x; cd /tmp/x'],
    ['declare -r T=/tmp/x; cd $T', 'declare -r T=/tmp/x; cd /tmp/x'],
    ["x='my dir'; ls $x", "x='my dir'; ls my dir"],
    ['x=a y=b; echo $x$y', 'x=a y=b; echo ab'],
    ['x=a; echo $x; x=b; echo $x', 'x=a; echo a; x=b; echo b'],
    ['x=; echo a$x b', 'x=; echo a b'],
    // A pattern in a value is a pattern where the value is used, by a shell that expands it there.
    ['x=*.sh; echo $x', 'x=*.sh; echo *.sh'],
    ['f=x.s?; bash $f', 'f=x.s?; bash x.s?'],
    ["f='x.s?'; bash $f", "f='x.s?'; bash x.s?"],
    ['f={x,y}.sh; bash $f', 'f={x,y}.sh; bash {x,y}.sh'],
    ['f=x.s[h]; bash "$f"', 'f=x.s[h]; bash "x.s[h]"'],
    ['f=x.s?; bash $~f', 'f=x.s?; bash x.s?'],
    ['x="rm -rf"; $x ~', 'x="rm -rf"; rm -rf ~'],
    ["x='rm -rf ~'; $x", "x='rm -rf ~'; rm -rf ~"],
    ['x=\'a b\'; echo "$x"', 'x=\'a b\'; echo "a b"'],
    ['f=x.s?; bash ${~f}', 'f=x.s?; bash x.s?'],
  ])('%j', (text, expected) => {
    expect(variant(text)).toBe(expected);
  });

  it.each<[string, string]>([
    ['single quotes keep the dollar', "x=rm; echo '$x -rf ~'"],
    ['an escaped dollar stays', 'x=rm; echo \\$x'],
    ['a use before the assignment is not a use of it', 'echo $x; x=rm'],
    ['a value that is itself an expansion is not known', 'x=$(date); echo $x'],
    ['a value with an escape inside double quotes is not known', 'x="a\\nb"; echo $x'],
    ['a name that is set for one command only is not set after it', 'x=rm echo $x'],
    ['a value kept out of double quotes that it could end', 'x=\'a"b\'; echo "$x"'],
    ['no assignment', 'echo $x'],
    ['nothing to replace', 'x=1; echo y'],
    ['an unknown name', 'x=1; echo $y'],
    ['a name that is only part of a longer one', 'x=1; echo $xy'],
  ])('leaves %s', (_name, text) => {
    expect(variant(text)).toBeNull();
  });

  it('puts a value with special characters in quotes where it is not already in them', () => {
    expect(variant("x='a;b'; echo $x")).toBe("x='a;b'; echo 'a;b'");
    // A value spelt in several quoted pieces is not read.
    expect(variant("x='it'\"'\"'s'; echo $x")).toBeNull();
  });

  it('does not put a long value anywhere, or work on a command too large to read twice', () => {
    expect(variant(`x=${'a'.repeat(300)}; echo $x`)).toBeNull();
    expect(variant(`x=1; echo ${'$x '.repeat(50_000)}`)).toBeNull();
  });

  it('does not grow the text past the limit', () => {
    const text = 'x=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; echo $x $x $x $x';
    expect(withKnownVariables(text, lex(text), text.length + 10)).toEqual([]);
  });

  it('stops after a few thousand substitutions, so a long text of uses is not a cost', () => {
    const text = `x=abc; ${'echo $x; '.repeat(10_000)}`;
    const found = variant(text);
    expect(found).not.toBeNull();
    expect((found as string).split('$x').length - 1).toBeGreaterThan(5_000);
  });
});

describe('splitCommand reads the variant as a text of its own', () => {
  it('has the command with its variables put in beside the command as written', () => {
    const { texts, segments } = splitCommand('x=rm; $x -rf ~');
    expect(texts).toEqual(['x=rm; $x -rf ~', 'x=rm; rm -rf ~']);
    expect(segments).toContain('rm -rf ~');
  });

  it('reads the commands inside a variant too', () => {
    const { texts } = splitCommand('a=rm; echo $($a -rf ~)');
    expect(texts).toContain('rm -rf ~');
  });

  it('has no variant for a command with none to put in', () => {
    expect(splitCommand('echo hello').texts).toEqual(['echo hello']);
  });
});

describe('withKnownVariables: a loop binds its variable to each item', () => {
  it.each<[string, string[]]>([
    ['for f in x.sh; do bash "$f"; done', ['for f in x.sh; do bash "x.sh"; done']],
    [
      'for f in a.sh b.sh; do bash $f; done',
      ['for f in a.sh b.sh; do bash a.sh; done', 'for f in a.sh b.sh; do bash b.sh; done'],
    ],
    ['for f in *.sh; do bash "$f"; done', ['for f in *.sh; do bash "*.sh"; done']],
    [
      'for f in a b c d; do echo $f; done',
      [
        'for f in a b c d; do echo a; done',
        'for f in a b c d; do echo b; done',
        'for f in a b c d; do echo c; done',
        'for f in a b c d; do echo d; done',
      ],
    ],
  ])('%j', (text, expected) => {
    expect(variants(text)).toEqual(expected);
  });

  it('leaves a loop over words it cannot spell out, or over too many', () => {
    expect(variants('for f in $(ls); do bash "$f"; done')).toEqual([]);
    expect(variants('for f in a b c d e; do bash "$f"; done')).toEqual([]);
    expect(variants('for f in "a b"; do bash "$f"; done')).toEqual([]);
  });
});

describe('an assignment after a control word or a grouping', () => {
  it.each<[string, string]>([
    ['if true; then c=rm; $c -rf ~; fi', 'rm -rf ~'],
    ['{ c=rm; $c -rf ~; }', 'rm -rf ~'],
    ['(c=rm; $c -rf ~)', 'rm -rf ~'],
    ['!(c=rm; $c -rf ~)', 'rm -rf ~'],
    ['f() { c=rm; $c -rf ~; }; f', 'rm -rf ~'],
    ['function f { c=rm; $c -rf ~; }; f', 'rm -rf ~'],
    ['while true; do c=rm; $c -rf ~; break; done', 'rm -rf ~'],
  ])('puts the value in for %s', (command, expected) => {
    expect(variants(command).some((text) => text.includes(expected))).toBe(true);
  });
});
