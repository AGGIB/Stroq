import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '@stroq/core';
import { inspectTree } from '../../../src/install/inspect/index.js';
import { buildTree } from '../../../src/install/tree.js';
import { PassportSchema, type Passport } from '../../../src/install/types.js';
import { PDF_SKILL, WEATHER_SERVER } from '../../helpers/inspect-fixtures.js';
import { CONTEXT, passportOf, type Files } from '../../helpers/inspect.js';
import { entriesOf } from '../../helpers/install-tree.js';

/**
 * The passports of two small artifacts, read by a person and then pinned. A change to what a reader
 * finds, to how a line is worded or to how lines are ordered shows up here as a change to a file that
 * is read in review, which is what a passport that people commit to a README needs. The files are
 * written by hand from the output once it was read; nothing in the suite rewrites them.
 */
const golden = (name: string): Passport =>
  PassportSchema.parse(
    JSON.parse(readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8')) as unknown,
  );

describe('golden passports', () => {
  it('reads a realistic small skill as the passport that was reviewed', () => {
    const passport = passportOf(PDF_SKILL, { kind: 'auto' });

    expect(stableStringify(passport)).toBe(stableStringify(golden('pdf-skill.passport.json')));
  });

  it('reads a realistic small MCP server as the passport that was reviewed', () => {
    const passport = passportOf(WEATHER_SERVER, { kind: 'auto' });

    expect(stableStringify(passport)).toBe(stableStringify(golden('weather-server.passport.json')));
  });

  it('names the tree of each fixture by the digest it had when it was reviewed', () => {
    expect(passportOf(PDF_SKILL).artifact.digest).toBe(
      golden('pdf-skill.passport.json').artifact.digest,
    );
    expect(passportOf(WEATHER_SERVER).artifact.digest).toBe(
      golden('weather-server.passport.json').artifact.digest,
    );
  });

  it('holds no time, no path of this machine, and nothing from the environment it was made in', () => {
    const text = stableStringify(passportOf(PDF_SKILL, { kind: 'auto' }));

    expect(text).not.toContain(process.cwd());
    expect(text).not.toContain(process.env['HOME'] ?? '/nonexistent-home');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});

/** A small deterministic generator, so a failing order can be told again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe('determinism', () => {
  const bytesOf = (files: Files, order: number): string => {
    const entries = shuffled(entriesOf(files), seeded(order));
    return stableStringify(
      inspectTree(buildTree(entries, { complete: true }), { ...CONTEXT, kind: 'auto' }),
    );
  };

  it.each([
    ['skill', PDF_SKILL],
    ['server', WEATHER_SERVER],
  ])('gives the same bytes for the %s in any order of its entries', (_name, files) => {
    const reference = bytesOf(files, 0);

    for (let order = 1; order <= 25; order += 1) {
      expect(bytesOf(files, order)).toBe(reference);
    }
  });

  it('gives the same bytes when the same tree is read twice', () => {
    expect(bytesOf(PDF_SKILL, 7)).toBe(bytesOf(PDF_SKILL, 7));
  });

  it('gives the same bytes whatever the order of the keys of a manifest', () => {
    const forward = {
      'package.json':
        '{"name":"x","main":"i.js","scripts":{"postinstall":"a","install":"b"},"dependencies":{"a":"file:../a","b":"file:../b"}}',
    };
    const backward = {
      'package.json':
        '{"dependencies":{"b":"file:../b","a":"file:../a"},"scripts":{"install":"b","postinstall":"a"},"main":"i.js","name":"x"}',
    };

    const first = JSON.stringify(
      passportOf(forward, { kind: 'mcp' }).lines.map((line) => [line.kind, line.subject]),
    );
    const second = JSON.stringify(
      passportOf(backward, { kind: 'mcp' }).lines.map((line) => [line.kind, line.subject]),
    );

    expect(first).toBe(second);
  });

  it('changes when a finding changes, and only then', () => {
    const base = passportOf(PDF_SKILL);
    const changed = passportOf({
      ...PDF_SKILL,
      'scripts/fill.py': `${String(PDF_SKILL['scripts/fill.py'])}\nTOKEN = os.environ["EXTRA_TOKEN"]\n`,
    });

    expect(stableStringify(changed)).not.toBe(stableStringify(base));
    expect(
      changed.lines.filter((line) => line.kind === 'cred.env').map((line) => line.subject),
    ).toContain('EXTRA_TOKEN');
  });
});
