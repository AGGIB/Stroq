import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `stroq sent` reads files and nothing else: it opens no connection and starts no process. This
 * holds it there statically. Every module `commands/sent.ts` reaches through relative imports is
 * read, and none may import a network or process module or call `fetch` or open a `WebSocket`.
 * `@stroq/core` is followed too, by its import statements only: as a classifier it holds those
 * words as data (`fetch(` and `require('child_process')` are among its patterns), so its text is
 * not searched. Imports are read by TypeScript's own pre-processor, which skips strings and comments.
 */

const CLI_SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const CORE_INDEX = fileURLToPath(new URL('../../../core/src/index.ts', import.meta.url));
const ENTRY = join(CLI_SRC, 'commands', 'sent.ts');

const FORBIDDEN = [
  'http',
  'https',
  'net',
  'tls',
  'dns',
  'dgram',
  'http2',
  'child_process',
  'worker_threads',
  'cluster',
];
const FORBIDDEN_TEXT: readonly RegExp[] = [/\bfetch\s*\(/, /\bWebSocket\b/, /\bXMLHttpRequest\b/];

/** Every module specifier a source file imports: static, re-exported, dynamic and `require`d. */
export function specifiersOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/** A forbidden builtin a specifier names, with or without `node:`, or null. */
function forbiddenIn(specifier: string): string | null {
  const bare = specifier.replace(/^node:/, '').split('/')[0] ?? '';
  return FORBIDDEN.includes(bare) ? specifier : null;
}

/** The `.ts` file a relative specifier names from `from`. */
function resolveTs(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const ts = base.replace(/\.js$/, '.ts');
  return existsSync(ts) ? ts : base;
}

/** Every module reached from `entry` through relative imports. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, 'utf8')))
      if (spec.startsWith('.')) queue.push(resolveTs(file, spec));
  }
  return [...seen].sort();
}

describe('the sent code path opens no connection and starts no process', () => {
  const cli = closure(ENTRY);

  it('reads the modules it is about', () => {
    const names = cli.map((f) => relative(CLI_SRC, f).replace(/\\/g, '/'));
    for (const expected of [
      'commands/sent.ts',
      'sent/keys.ts',
      'sent/needles.ts',
      'sent/scan-sessions.ts',
      'sent/where.ts',
      'sent/codex.ts',
      'sent/cursor.ts',
      'replay/transcript.ts',
      'replay/transcript-parse.ts',
      'replay/claude-session.ts',
      'replay/spilled.ts',
    ])
      expect(names).toContain(expected);
  });

  it.each(closure(ENTRY).map((f) => [relative(CLI_SRC, f), f]))(
    '%s imports no network or process module and makes no request',
    (_name, file) => {
      const source = readFileSync(file as string, 'utf8');
      expect(
        specifiersOf(source)
          .map(forbiddenIn)
          .filter((s) => s !== null),
      ).toEqual([]);
      for (const pattern of FORBIDDEN_TEXT) expect(source).not.toMatch(pattern);
      // Only the core is reached by name: no other package is pulled in.
      for (const spec of specifiersOf(source).filter(
        (s) => !s.startsWith('.') && !s.startsWith('node:'),
      ))
        expect(spec).toBe('@stroq/core');
    },
  );

  it('the core it imports names no network or process module either', () => {
    const named = closure(CORE_INDEX).flatMap((file) =>
      specifiersOf(readFileSync(file, 'utf8'))
        .map(forbiddenIn)
        .filter((s) => s !== null)
        .map((s) => `${relative(CORE_INDEX, file)}: ${s}`),
    );
    expect(named).toEqual([]);
    expect(closure(CORE_INDEX).length).toBeGreaterThan(50);
  });

  it('would see one if it were there', () => {
    expect(specifiersOf("import { request } from 'node:https';").map(forbiddenIn)).toEqual([
      'node:https',
    ]);
    expect(specifiersOf("const cp = await import('child_process');").map(forbiddenIn)).toEqual([
      'child_process',
    ]);
    expect(specifiersOf("export { x } from 'node:net';").map(forbiddenIn)).toEqual(['node:net']);
    expect(FORBIDDEN_TEXT.some((p) => p.test('await fetch(url)'))).toBe(true);
    expect(FORBIDDEN_TEXT.some((p) => p.test("tool === 'WebFetch'"))).toBe(false);
  });
});
