import { describe, expect, it } from 'vitest';
import {
  decodeEscapes,
  expandHeredoc,
  hasAmbiguousOctal,
  hasExpansion,
  heredocExpands,
  stdinPath,
} from '../../src/actions/shell-escapes.js';

describe('stdinPath: whether a path names the standard input of this process', () => {
  it.each([
    '/dev/stdin',
    '/dev//stdin',
    '/dev/./stdin',
    '/dev/stdin/',
    '/dev/fd/0',
    '/dev/fd/00',
    '/dev/fd/../fd/0',
    '/dev/../dev/stdin',
    '/proc/self/fd/0',
    '/proc/thread-self/fd/0',
    '/proc/self/fd/000',
  ])('%s is the standard input', (path) => {
    expect(stdinPath(path)).toBe('stdin');
  });

  it.each([
    '/dev/fd/3',
    '/dev/fd/12',
    '/dev/stdout',
    '/dev/stderr',
    '/proc/self/fd/3',
    '/proc/1234/fd/0',
  ])('%s is another descriptor', (path) => {
    expect(stdinPath(path)).toBe('descriptor');
  });

  it.each(['/dev/std?n', '/dev/fd/*', '/dev/fd/[0]', '/proc/$$/fd/0', '/dev/$x'])(
    '%s is a stream this cannot name',
    (path) => {
      expect(stdinPath(path)).toBe('unknown');
    },
  );

  it.each(['x.sh', '/tmp/x.sh', '/dev/null', '/dev/zero', '/devices/stdin', './dev/stdin'])(
    '%s is neither',
    (path) => {
      expect(stdinPath(path)).toBeNull();
    },
  );
});

describe('decodeEscapes: what echo, printf and a dollar-quote make of a backslash', () => {
  it.each<[string, 'echo' | 'printf' | 'ansi', string]>([
    ['\\x72m', 'echo', 'rm'],
    ['\\x72m', 'printf', 'rm'],
    ['\\u0072m', 'echo', 'rm'],
    ['\\U00000072m', 'echo', 'rm'],
    ['\\0162m', 'echo', 'rm'],
    ['\\162m', 'printf', 'rm'],
    ['\\162m', 'ansi', 'rm'],
    ['ls\\cJrm', 'ansi', 'ls\nrm'],
    ['ls\\cjrm', 'ansi', 'ls\nrm'],
    ['\\? rm', 'ansi', '? rm'],
    ['a\\nb\\tc', 'echo', 'a\nb\tc'],
    ["it\\'s", 'echo', "it\\'s"],
    ["it\\'s", 'printf', "it's"],
    ["it\\'s", 'ansi', "it's"],
    ['100\\\\', 'echo', '100\\'],
    ['\\q stays', 'echo', '\\q stays'],
    ['\\x', 'echo', '\\x'],
    ['\\', 'echo', '\\'],
  ])('%s as %s is %j', (text, mode, expected) => {
    expect(decodeEscapes(text, mode)).toBe(expected);
  });

  it('drops a NUL, as a shell that is handed one does not read what follows it as written', () => {
    expect(decodeEscapes('a\\x00b', 'echo')).toBe('ab');
    expect(decodeEscapes('a\\0b', 'echo')).toBe('ab');
  });

  it('takes a code point past the last one as written', () => {
    expect(decodeEscapes('\\UFFFFFFFF', 'echo')).toBe('\\UFFFFFFFF');
  });

  it('knows an octal escape with no leading zero is read in more than one way', () => {
    expect(hasAmbiguousOctal('r\\155')).toBe(true);
    expect(hasAmbiguousOctal('r\\0155')).toBe(false);
    expect(hasAmbiguousOctal('\\\\155')).toBe(false);
    expect(hasAmbiguousOctal('no escapes')).toBe(false);
  });
});

describe('hasExpansion: whether the shell rewrites a word before the command sees it', () => {
  it.each([
    '$x',
    '${x}',
    '$(x)',
    '`x`',
    '$((1+2))',
    '*.sh',
    'a?',
    '[ab]',
    '{a,b}',
    '{1..3}',
    '=bash',
    '=(x)',
    '"$x"',
    '$1',
    '$@',
    '${x:-{}',
  ])('%s expands', (word) => {
    expect(hasExpansion(word)).toBe(true);
  });

  it.each(["'$x'", '\\$x', "$'$x'", 'plain', '"a b"', '"*"', "'{a,b}'", 'a{b', '{a}', '$', 'a$'])(
    '%s does not',
    (word) => {
      expect(hasExpansion(word)).toBe(false);
    },
  );
});

describe('the body of a here-document', () => {
  it('expands when it holds a dollar, a backtick, or a backslash that takes a character with it', () => {
    expect(heredocExpands('echo $x')).toBe(true);
    expect(heredocExpands('echo `x`')).toBe(true);
    expect(heredocExpands('echo \\$x')).toBe(true);
    expect(heredocExpands('echo plain\nmore')).toBe(false);
  });

  it('hands on its text with the backslashes the shell reads taken off', () => {
    expect(expandHeredoc('rm -rf \\$X\n')).toBe('rm -rf $X\n');
    expect(expandHeredoc('a \\` b \\\\ c')).toBe('a ` b \\ c');
    expect(expandHeredoc('one \\\ntwo')).toBe('one two');
    expect(expandHeredoc('keep \\n and \\x')).toBe('keep \\n and \\x');
  });
});
