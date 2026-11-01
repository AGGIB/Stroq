import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_ENTRY } from './helpers/cli-entry.js';

/**
 * What the build puts in `dist/` for the sake of the hook's speed (`tsup.config.ts`): the tests that
 * spawn the CLI cannot tell if it did, since a bundle without these still gives the right answers.
 */
const dist = dirname(CLI_ENTRY);
const files = readdirSync(dist).filter((name) => name.endsWith('.js'));
const sourceOf = (name: string): string => readFileSync(join(dist, name), 'utf8');

describe('the built CLI', () => {
  it('carries the literals its rules require, worked out at build time', () => {
    // The rules are one string in the code, and `prefilters` is a key of the JSON in it.
    const holders = files.filter((name) => sourceOf(name).includes('"prefilters":{"STROQ-2026-'));
    expect(holders).toHaveLength(1);
  });

  it('holds no zod locale but the English one', () => {
    const text = files.map(sourceOf).join('\n');
    expect(text).not.toContain('Неверный ввод'); // the Russian locale's message
    expect(text).not.toContain('Entrada inválida'); // the Spanish one
    expect(text).toContain('Invalid input');
  });

  it('ships the licence of the zod it bundles, beside package.json and listed in its files', () => {
    const root = dirname(dist);
    expect(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toMatch(
      /## zod [\s\S]*MIT License/,
    );
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });

  it('holds only .js and .json files, the only ones the console admits in its runtime digest', () => {
    // console/scripts/runtime-digest.mjs refuses a dist/ with any other name in it, and every
    // console service that checks the engine then reports it unavailable.
    expect(readdirSync(dist).filter((name) => !/^[\w.-]+\.(?:js|json)$/.test(name))).toEqual([]);
  });
});
