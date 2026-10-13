import { describe, expect, it } from 'vitest';
import {
  MAX_BRACE_WORDS,
  expandBraces,
  expandWrittenBraces,
} from '../../src/actions/brace-expansion.js';

describe('expandBraces: the words a shell makes of a word before any command sees it', () => {
  it.each<[string, string[]]>([
    ['{a,b}', ['a', 'b']],
    ['x{a,b}y', ['xay', 'xby']],
    ['{~,/tmp/x}', ['~', '/tmp/x']],
    ['{a,b}{c,d}', ['ac', 'ad', 'bc', 'bd']],
    ['{a,{b,c}}', ['a', 'b', 'c']],
    ['{1..3}', ['1', '2', '3']],
    ['{3..1}', ['3', '2', '1']],
    ['{a..c}', ['a', 'b', 'c']],
    ['{1..7..3}', ['1', '4', '7']],
    // Padded as a zsh and a bash since 4 pad them, and as an older bash does not.
    ['{01..03}', ['01', '02', '03', '1', '2', '3']],
    ['x{001..002}', ['x001', 'x002', 'x1', 'x2']],
    ['{08..09}', ['08', '09', '8', '9']],
    ['{-01..01}', ['-01', '00', '01', '-1', '0', '1']],
    ['{1..03}', ['01', '02', '03', '1', '2', '3']],
    ['{,x}', ['', 'x']],
    ['a{b', ['a{b']],
    ['{a}', ['{a}']],
    ['${x}', ['${x}']],
    ['\\{a,b}', ['\\{a,b}']],
    ['plain', ['plain']],
  ])('%s', (word, words) => {
    expect(expandBraces(word)).toEqual(words);
  });

  it('gives up on a word that would make more than it reads, and says so', () => {
    expect(expandBraces('{a,b}'.repeat(7))).toBeNull();
    expect(expandBraces('{1..1000}')).toBeNull();
    expect(
      expandBraces(`{${Array.from({ length: MAX_BRACE_WORDS }, (_, n) => n).join(',')}}`),
    ).toHaveLength(MAX_BRACE_WORDS);
  });

  it('gives up on a word too long to be a target', () => {
    expect(expandBraces(`{${'a,'.repeat(400)}b}`)).toBeNull();
    expect(expandBraces('{'.repeat(100_000))).toBeNull();
  });
});

describe('expandWrittenBraces: a word as it is written, with its quotes still on', () => {
  it.each<[string, string[]]>([
    ["{bash,-c,'rm -rf ~'}", ['bash', '-c', "'rm -rf ~'"]],
    ['{a,"b,c"}', ['a', '"b,c"']],
    ["{a,'b}'", ["{a,'b}'"]],
    ["x{a,b}'{c,d}'", ["xa'{c,d}'", "xb'{c,d}'"]],
    ['{a,$(echo b,c)}', ['a', '$(echo b,c)']],
    ['{a,`b,c`}', ['a', '`b,c`']],
    ["{$'a,b',c}", ["$'a,b'", 'c']],
    ["{$'a\\'b',c}", ["$'a\\'b'", 'c']],
    ['{rm,-rf,~}', ['rm', '-rf', '~']],
    ["{,'x y'}", ['', "'x y'"]],
    ["'{a,b}'", ["'{a,b}'"]],
    ['"{a,b}"', ['"{a,b}"']],
    ['"a\\""{b,c}', ['"a\\""b', '"a\\""c']],
    ['"a\\"{b,c}', ['"a\\"{b,c}']],
    ['\\{a,b}', ['\\{a,b}']],
    ['{a,b\\,c}', ['a', 'b\\,c']],
    ['${x:-a,b}{c,d}', ['${x:-a,b}c', '${x:-a,b}d']],
    ['{a,$(b (c) d)}', ['a', '$(b (c) d)']],
    ["{a,'unclosed}", ["{a,'unclosed}"]],
    ['{a,"unclosed}', ['{a,"unclosed}']],
    ['{a,`unclosed}', ['{a,`unclosed}']],
    ['{a,$(unclosed}', ['{a,$(unclosed}']],
    ['plain', ['plain']],
  ])('%s', (word, words) => {
    expect(expandWrittenBraces(word)).toEqual(words);
  });

  it('gives up where the plain one does', () => {
    expect(expandWrittenBraces('{a,b}'.repeat(7))).toBeNull();
    expect(expandWrittenBraces(`{${'a,'.repeat(400)}b}`)).toBeNull();
  });
});
