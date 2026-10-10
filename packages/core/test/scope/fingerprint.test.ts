import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileTarget, fingerprintOf, mcpTarget, shellTarget } from '../../src/scope/fingerprint.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('fingerprintOf', () => {
  it('is the sha256 of the canonical JSON of {tool, kind, target}', () => {
    const expected = sha256('{"kind":"file:write","target":"/p/a.ts","tool":"Edit"}');
    expect(fingerprintOf('Edit', 'file:write', '/p/a.ts')).toBe(expected);
    expect(fingerprintOf('Edit', 'file:write', '/p/a.ts')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with each of the three parts, and cannot be fooled by moving text between them', () => {
    const base = fingerprintOf('Edit', 'file:write', '/p/a.ts');
    expect(fingerprintOf('Write', 'file:write', '/p/a.ts')).not.toBe(base);
    expect(fingerprintOf('Edit', 'file:read', '/p/a.ts')).not.toBe(base);
    expect(fingerprintOf('Edit', 'file:write', '/p/b.ts')).not.toBe(base);
    expect(fingerprintOf('Edit', 'file:writ', 'e/p/a.ts')).not.toBe(base);
    expect(fingerprintOf('Edi', 'tfile:write', '/p/a.ts')).not.toBe(base);
  });
});

describe('target helpers', () => {
  it('names a file by its real path when there is one, by its path otherwise', () => {
    expect(fileTarget('/p/link', '/p/real')).toBe('/p/real');
    expect(fileTarget('/p/link', undefined)).toBe('/p/link');
    expect(fileTarget('/p/link')).toBe('/p/link');
  });

  it('names an MCP call by server/tool and the digest of its canonical arguments', () => {
    const args = { b: 1, a: { y: [1, 2], x: 'é' } };
    const digest = sha256('{"a":{"x":"é","y":[1,2]},"b":1}');
    expect(mcpTarget('docs', 'search', args)).toBe(`docs/search#${digest}`);
  });

  it('gives the same MCP target whatever order the arguments were written in, and another for other arguments', () => {
    expect(mcpTarget('s', 't', { a: 1, b: 2 })).toBe(mcpTarget('s', 't', { b: 2, a: 1 }));
    expect(mcpTarget('s', 't', { a: 1 })).not.toBe(mcpTarget('s', 't', { a: 2 }));
    expect(mcpTarget('s', 't', {})).not.toBe(mcpTarget('s', 'u', {}));
    expect(mcpTarget('s', 't', {})).not.toBe(mcpTarget('r', 't', {}));
  });

  it('names a shell command by the digest of the command with its whitespace collapsed', () => {
    expect(shellTarget('npm   test')).toBe(sha256('npm test'));
    expect(shellTarget('  npm\ttest \n')).toBe(sha256('npm test'));
    expect(shellTarget('npm test\r\n\r\n')).toBe(sha256('npm test'));
    expect(shellTarget('npm test')).not.toBe(shellTarget('npm tests'));
  });

  it('collapses ASCII whitespace only: a no-break space is part of a word to a shell, not a gap', () => {
    expect(shellTarget('echo a b')).not.toBe(shellTarget('echo a b'));
    expect(shellTarget('echo a b')).not.toBe(shellTarget('echo a b'));
  });

  it('keeps the case and the quoting of a command', () => {
    expect(shellTarget('echo X')).not.toBe(shellTarget('echo x'));
    expect(shellTarget("echo 'x'")).not.toBe(shellTarget('echo x'));
  });

  it('copes with a very long command in one pass', () => {
    expect(shellTarget(`a${' '.repeat(200_000)}b`)).toBe(sha256('a b'));
  });
});
