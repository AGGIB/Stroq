import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManifestEntry } from '../../src/harden/manifest.js';
import { signedManifestText } from '../../src/harden/manifest-seal.js';
import { ensureStateMacKeySync } from '../../src/state-mac.js';
import { fakeEnv, tempDir } from './helpers.js';

export const FAKE_SECRET = 'stroq_attack_fixture_value_0123456789';

/** A manifest entry that satisfies the schema, with `overrides` laid over it. */
export const entry = (overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
  recipe: 'claude-deny-read',
  created: false,
  real: join(tmpdir(), 'stroq-fixture', 'settings.json'),
  root: null,
  edits: [
    {
      kind: 'json-array-add',
      path: ['permissions', 'deny'],
      value: 'Read(~/.ssh/**)',
      preexisting: false,
      createdFrom: 2,
    },
    {
      kind: 'json-set',
      path: ['sandbox', 'enabled'],
      value: true,
      previous: { present: false },
      createdFrom: 1,
    },
    {
      kind: 'text-block',
      id: 'cursor-ignore',
      lines: ['.env'],
      previous: null,
      prefix: '\n',
      closesLastLine: false,
      suffix: '\n',
    },
  ],
  shaBefore: 'a'.repeat(64),
  shaAfter: 'b'.repeat(64),
  backup: '20261010T100000000Z-abc123',
  stroqVersion: '0.23.0',
  appliedAt: '2026-10-10T10:00:00.000Z',
  ...overrides,
});

/** A Stroq home, the real path of a file somebody else owns, and where the manifest goes. */
export function setup() {
  const home = tempDir('home');
  const file = join(tempDir('project'), 'settings.json');
  const manifestFile = join(home, 'harden', 'manifest.json');
  return { home, file, env: fakeEnv(home), manifestFile };
}

/** Writes `content` where the manifest goes, as something other than the engine might have. */
export function plant(manifestFile: string, content: string | object): void {
  mkdirSync(join(manifestFile, '..'), { recursive: true });
  writeFileSync(manifestFile, typeof content === 'string' ? content : JSON.stringify(content));
}

/** The text of a version 2 manifest with `files`, signed with the key of `home` (made if need be). */
export const signedText = (home: string, files: Readonly<Record<string, unknown>>): string =>
  signedManifestText(files, ensureStateMacKeySync(home));

/** What `fn` throws, or undefined when it does not. */
export const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};
