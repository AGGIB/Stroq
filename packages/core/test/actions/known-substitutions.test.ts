import { describe, expect, it } from 'vitest';
import { withLiteralSubstitutions } from '../../src/actions/known-substitutions.js';
import { lex } from '../../src/actions/shell-lex.js';

const put = (text: string): string | null => withLiteralSubstitutions(text, lex(text));

describe('withLiteralSubstitutions: a substitution that only prints a literal is what it prints', () => {
  it.each<[string, string]>([
    ['$(echo rm) -rf ~', 'rm -rf ~'],
    ['`echo rm` -rf ~', 'rm -rf ~'],
    ['"$(echo rm)" -rf ~', '"rm" -rf ~'],
    ['$(printf rm) -rf ~', 'rm -rf ~'],
    ['$(printf "%s" rm) -rf ~', 'rm -rf ~'],
    ['$(echo r)m -rf ~', 'rm -rf ~'],
    ['$(echo rm -rf ~)', 'rm -rf ~'],
    ['$(echo "rm -rf ~")', 'rm -rf ~'],
    ['x=$(echo rm); $x -rf ~', 'x=rm; $x -rf ~'],
    ['$(echo a) $(echo b)', 'a b'],
    ['$(echo rm)\n', 'rm\n'],
    ['$(which rm) -rf ~', 'rm -rf ~'],
    ['`command -v rm` -rf ~', 'rm -rf ~'],
    ['$(type -p rm) -rf ~', 'rm -rf ~'],
    ['$(whence rm) -rf ~', 'rm -rf ~'],
    ["$(echo 'it''s') y", 'its y'],
  ])('%j', (text, expected) => {
    expect(put(text)).toBe(expected);
  });

  it.each([
    'echo hello',
    '$(echo $HOME) x',
    '$(echo "$x") x',
    '$(date) x',
    '$(echo rm >/dev/null) x',
    '$(echo rm; echo x) y',
    '$(echo $(echo rm)) y',
    '<(echo rm) y',
    '>(echo rm) y',
    '$(cat name.txt) -rf ~',
    '$(echo "a; b") y',
    '$(echo x.s?) y',
    '$(echo -n) y',
    `$(echo ${'a'.repeat(300)}) y`,
    '$(printf "%d" 5) y',
  ])('leaves %j as it is', (text) => {
    expect(put(text)).toBeNull();
  });

  it('puts only the substitutions it can, and keeps the rest', () => {
    expect(put('echo $(echo a) $(date) $(echo b)')).toBe('echo a $(date) b');
  });

  it('puts in no more than it is allowed to', () => {
    const many = '$(echo a) '.repeat(300);
    const found = put(many) ?? '';
    expect(found.startsWith('a a a')).toBe(true);
    expect(found).toContain('$(echo a)');
  });
});
