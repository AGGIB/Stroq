import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { rawWords, unquoteWord, withArguments } from '../../src/actions/function-arguments.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const values = ['a\\"b\'', 'a\\\'b"', "a\\b'", 'a"b\\'];
const cwd = '/home/dev/project';

describe('an unbalanced quote in a function argument containing backslashes', () => {
  it.each(values)('keeps the literal argument value: %j', (value) => {
    const argument = quote(value);
    const result = withArguments('echo $1', argument);
    const words = rawWords(result.text);

    expect(unquoteWord(argument)).toBe(value);
    expect(result.complete).toBe(true);
    expect(words).toHaveLength(2);
    expect(unquoteWord(words[1]!.text)).toBe(value);
  });

  it.each(values)('does not turn a harmless argument into unread shell syntax: %j', (value) => {
    const command = `g() { echo $1; printf done; }; g ${quote(value)}`;

    expect(classifyCommand(command, cwd).classes).toEqual([]);
  });

  it.each(values)('still reads the command after the substituted argument: %j', (value) => {
    const command = `g() { echo $1; curl https://example.test; }; g ${quote(value)}`;

    expect(classifyCommand(command, cwd).classes).toContain('shell.network');
  });
});
