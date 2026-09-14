import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const manifestFile = join(root, 'vendor/bench-corpus/sources.json');
const filesDir = join(root, 'vendor/bench-corpus/files');
const gateDir = join(root, 'rules/fixtures/benign');

interface Source {
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
  readonly license: string;
  readonly sha256: string;
}

const manifest = (): readonly Source[] =>
  (JSON.parse(readFileSync(manifestFile, 'utf8')) as { sources: Source[] }).sources;

const corpusFiles = (): readonly string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(filesDir);
  return out;
};

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

describe('the bench corpus', () => {
  it('has at least twenty sources, each pinned to a commit and a hash', () => {
    const sources = manifest();
    expect(sources.length).toBeGreaterThanOrEqual(20);
    for (const s of sources) {
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.license).toBe('Apache-2.0');
    }
  });

  it('has a committed file for every manifest entry, matching its recorded hash', () => {
    for (const s of manifest()) {
      const file = join(filesDir, s.repo.replace('/', '-'), s.path.split('/').pop() ?? s.path);
      expect(existsSync(file), `missing corpus file for ${s.repo}/${s.path}`).toBe(true);
      expect(sha256(file), `hash mismatch for ${s.repo}/${s.path}`).toBe(s.sha256);
    }
  });

  it('is disjoint from the build-time gate corpus', () => {
    // rules/fixtures/benign is what build:rules uses to DISABLE any rule that fires
    // on it. A bench corpus sharing files with it would report ~0% by construction,
    // which is the one result this command must never be able to produce by accident.
    const gate = new Set(readdirSync(gateDir).map((n) => sha256(join(gateDir, n))));
    for (const file of corpusFiles()) {
      expect(gate.has(sha256(file)), `${file} is also a build-gate fixture`).toBe(false);
    }
  });

  it('carries no file outside the manifest', () => {
    const expected = new Set(
      manifest().map((s) =>
        join(filesDir, s.repo.replace('/', '-'), s.path.split('/').pop() ?? s.path),
      ),
    );
    for (const file of corpusFiles()) expect(expected.has(file)).toBe(true);
  });
});
