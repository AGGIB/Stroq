import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES, emptyManifest, readManifest } from '../../src/harden/manifest.js';
import { HardenError } from '../../src/harden/types.js';
import { FAKE_SECRET, entry, plant, setup, thrownBy } from './manifest-fixtures.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

describe('readManifest: what it refuses', () => {
  const { file } = { file: join(tempDir('keys'), 'settings.json') };
  const manifestOf = (value: unknown): object => ({ version: 1, files: { [file]: [value] } });
  const withEdit = (edit: unknown): object => manifestOf({ ...entry(), edits: [edit] });

  const bad: [string, unknown][] = [
    ['an array at the top', []],
    ['null', null],
    ['a string', 'manifest'],
    ['a version it does not know', { version: 2, files: {} }],
    ['no version', { files: {} }],
    ['files that are not an object', { version: 1, files: [] }],
    ['an unknown key at the top', { version: 1, files: {}, extra: 1 }],
    ['a file with entries that are not a list', { version: 1, files: { [file]: entry() } }],
    ['a relative path as a file', { version: 1, files: { 'settings.json': [entry()] } }],
    ['an unknown key in an entry', manifestOf({ ...entry(), extra: true })],
    ['a missing field in an entry', manifestOf({ ...entry(), shaAfter: undefined })],
    ['a sha in capitals', manifestOf(entry({ shaAfter: 'B'.repeat(64) }))],
    ['a sha that is too short', manifestOf(entry({ shaBefore: 'abc' }))],
    ['a time that is not a time', manifestOf(entry({ appliedAt: 'yesterday' }))],
    ['a copy id that climbs out', manifestOf(entry({ backup: '../../etc' }))],
    ['a copy id with a slash', manifestOf(entry({ backup: 'a/b' }))],
    ['an empty recipe', manifestOf(entry({ recipe: '' }))],
    ['edits that are not a list', manifestOf({ ...entry(), edits: {} })],
    ['an edit of a kind it does not know', withEdit({ kind: 'json-delete', path: ['a'] })],
    ['an unknown key in an edit', withEdit({ ...entry().edits[0], extra: 1 })],
    ['an edit with an empty path', withEdit({ ...entry().edits[0], path: [] })],
    ['an edit with a path part that is empty', withEdit({ ...entry().edits[0], path: ['a', ''] })],
    ['a created-from before the start', withEdit({ ...entry().edits[0], createdFrom: -1 })],
    ['a created-from past the end', withEdit({ ...entry().edits[0], createdFrom: 3 })],
    [
      'a created-from that is not a whole number',
      withEdit({ ...entry().edits[0], createdFrom: 1.5 }),
    ],
    [
      'a set with a previous it cannot read',
      withEdit({ ...entry().edits[1], previous: { present: 'maybe' } }),
    ],
    ['a block id that is not a plain name', withEdit({ ...entry().edits[2], id: 'a b' })],
    ['block lines that are not strings', withEdit({ ...entry().edits[2], lines: [1] })],
    [
      'a block prefix that is not a separator',
      withEdit({ ...entry().edits[2], prefix: 'x'.repeat(40) }),
    ],
  ];

  it.each(bad)('rejects %s, with a typed error', (_name, content) => {
    const { env, manifestFile } = setup();
    plant(manifestFile, content as object);

    const error = thrownBy(() => readManifest(env));

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'manifest-invalid' });
  });

  it('rejects text that is not JSON, without quoting any of it', () => {
    const { env, manifestFile } = setup();
    plant(manifestFile, `{"version": 1, "files": ${FAKE_SECRET}`);

    const error = thrownBy(() => readManifest(env));

    expect(error).toMatchObject({ code: 'manifest-invalid' });
    expect((error as Error).message).not.toContain(FAKE_SECRET);
  });

  it('does not repeat a value it found in what it says is wrong', () => {
    const { env, manifestFile } = setup();
    plant(
      manifestFile,
      manifestOf({ ...entry(), recipe: 5, stroqVersion: FAKE_SECRET, extra: FAKE_SECRET }),
    );

    const error = thrownBy(() => readManifest(env));

    expect(error).toMatchObject({ code: 'manifest-invalid' });
    expect((error as Error).message).not.toContain(FAKE_SECRET);
  });

  // `z.record` quietly drops a `__proto__` key, which would make a manifest with a file in it
  // read as one without.
  it('rejects a file called __proto__ rather than reading the manifest without it', () => {
    const { env, manifestFile } = setup();
    plant(
      manifestFile,
      `{"version": 1, "files": {"__proto__": [], ${JSON.stringify(file)}: [${JSON.stringify(entry())}]}}`,
    );

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-invalid' });
  });

  it('gives nothing at all when one file is good and another is not', () => {
    const { env, manifestFile } = setup();
    const other = join(tempDir('other'), 'b.json');
    plant(manifestFile, {
      version: 1,
      files: { [file]: [entry()], [other]: [entry({ shaAfter: 'nope' })] },
    });

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-invalid' });
  });

  it('rejects a manifest over 1 MiB without reading it', () => {
    const { env, manifestFile } = setup();
    plant(manifestFile, ' '.repeat(MAX_MANIFEST_BYTES + 1));

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-too-large' });
  });

  it('reads a manifest of exactly 1 MiB', () => {
    const { env, manifestFile } = setup();
    const body = '{"version": 1, "files": {}}';
    plant(manifestFile, body + ' '.repeat(MAX_MANIFEST_BYTES - body.length));

    expect(readManifest(env)).toEqual(emptyManifest());
  });

  it('rejects a directory where the manifest goes', () => {
    const { env, manifestFile } = setup();
    mkdirSync(manifestFile, { recursive: true });

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
  });

  it.skipIf(onWindows)(
    'rejects a link where the manifest goes, and does not read what it leads to',
    () => {
      const { env, manifestFile } = setup();
      const elsewhere = join(tempDir('elsewhere'), 'other.json');
      writeFileSync(elsewhere, JSON.stringify({ version: 1, files: {} }));
      mkdirSync(join(manifestFile, '..'), { recursive: true });
      symlinkSync(elsewhere, manifestFile);

      const error = thrownBy(() => readManifest(env));

      expect(error).toBeInstanceOf(HardenError);
      expect(error).toMatchObject({ code: 'manifest-unsafe' });
    },
  );

  it.skipIf(onWindows)('rejects a link that points nowhere', () => {
    const { env, manifestFile } = setup();
    mkdirSync(join(manifestFile, '..'), { recursive: true });
    symlinkSync(join(tempDir('gone'), 'missing.json'), manifestFile);

    expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-unsafe' });
  });
});
