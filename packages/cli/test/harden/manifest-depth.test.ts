import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MANIFEST_BYTES,
  emptyManifest,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from '../../src/harden/manifest.js';
import { HardenError, type JsonValue } from '../../src/harden/types.js';
import { cpuNow } from '../helpers/cpu-time.js';
import { entry, plant, setup, thrownBy } from './manifest-fixtures.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/** An array nested `depth` deep, as a value (what a recipe could ask `json-set` to write). */
function nested(depth: number): JsonValue {
  let value: JsonValue = [];
  for (let i = 1; i < depth; i += 1) value = [value];
  return value;
}

/** The text of a manifest whose only edit sets a value nested `depth` deep. */
function manifestText(file: string, depth: number): string {
  const edit = {
    kind: 'json-set',
    path: ['a'],
    value: 'VALUE',
    previous: { present: false },
    createdFrom: 1,
  };
  const base = JSON.stringify({ version: 1, files: { [file]: [{ ...entry(), edits: [edit] }] } });
  return base.replace('"VALUE"', `${'['.repeat(depth)}${']'.repeat(depth)}`);
}

/**
 * The schema that checks a manifest is recursive (a recorded value is any JSON), and a document a
 * few thousand levels deep, which fits in a few kilobytes, overflows the stack of whatever checks
 * it. That must come out as the typed error every other bad manifest gets, not as a raw
 * RangeError that no caller expects from a reader.
 */
describe('readManifest: a manifest nested far deeper than Stroq writes one', () => {
  it.each([5_000, 20_000, 400_000])('refuses one %s levels deep with a typed error', (depth) => {
    const { env, file, manifestFile } = setup();
    const text = manifestText(file, depth);
    expect(text.length).toBeLessThan(MAX_MANIFEST_BYTES);
    plant(manifestFile, text);

    const error = thrownBy(() => readManifest(env));

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'manifest-invalid' });
  });

  it('refuses it quickly: the depth is counted with a stack of its own, not by recursing', () => {
    const { env, file, manifestFile } = setup();
    plant(manifestFile, manifestText(file, 450_000));
    const started = cpuNow();

    thrownBy(() => readManifest(env));

    expect(cpuNow() - started).toBeLessThan(3_000);
  });

  it('refuses deep nesting wherever it is, not only in a recorded value', () => {
    const { env, manifestFile } = setup();
    const deep = '['.repeat(6_000) + ']'.repeat(6_000);
    for (const text of [
      `{"version": 1, "files": {}, "extra": ${deep}}`,
      `{"version": 1, "files": ${deep}}`,
      `{"version": 1, "files": {"/x": ${deep}}}`,
    ]) {
      plant(manifestFile, text);
      expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-invalid' });
    }
  });

  it('says where it gave up and never quotes a value', () => {
    const { env, file, manifestFile } = setup();
    plant(manifestFile, manifestText(file, 6_000));

    const error = thrownBy(() => readManifest(env)) as Error;

    expect(error.message).toMatch(/nested deeper/);
    expect(error.message).not.toContain('VALUE');
  });

  it('still reads the deepest value a recipe is allowed to write', () => {
    const { env, file } = setup();
    const value = nested(64);
    const manifest: Manifest = {
      version: 1,
      files: {
        [file]: [
          {
            ...entry(),
            edits: [
              {
                kind: 'json-set',
                path: ['a'],
                value,
                previous: { present: false },
                createdFrom: 1,
              },
            ],
          },
        ],
      },
    };

    return writeManifest(env, manifest).then(() => {
      expect(readManifest(env)).toEqual(manifest);
    });
  });
});

describe('writeManifest: a manifest nested far deeper than Stroq writes one', () => {
  it('refuses it with a typed error, and writes nothing', async () => {
    const { env, file } = setup();
    await writeManifest(env, emptyManifest());
    const manifest: Manifest = {
      version: 1,
      files: {
        [file]: [
          {
            ...entry(),
            edits: [
              {
                kind: 'json-set',
                path: ['a'],
                value: nested(20_000),
                previous: { present: false },
                createdFrom: 1,
              },
            ],
          },
        ],
      },
    };

    const error = await writeManifest(env, manifest).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'manifest-invalid' });
    expect(readManifest(env)).toEqual(emptyManifest());
  });

  it('does not loop on a manifest that contains itself', async () => {
    const { env, file } = setup();
    const looping: Record<string, unknown> = { ...entry() };
    looping['edits'] = [looping];

    const error = await writeManifest(env, {
      version: 1,
      files: { [file]: [looping as unknown as ManifestEntry] },
    }).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'manifest-invalid' });
  });
});
