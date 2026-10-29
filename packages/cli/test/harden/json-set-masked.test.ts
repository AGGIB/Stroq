import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MASKED_PREVIOUS_VALUE,
  REPLACED_CREDENTIAL_NOTICE,
  planJsonEdits,
  undoJsonEdits,
} from '../../src/harden/json-edit.js';
import { emptyManifest, readManifest, writeManifest } from '../../src/harden/manifest.js';
import type { JsonEdit } from '../../src/harden/types.js';
import { entry, FAKE_SECRET, plant, setup, thrownBy } from './manifest-fixtures.js';
import { applied, engine, jsonText, owner, undo } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const set = (path: string[], value: unknown): JsonEdit => ({
  kind: 'json-set',
  path,
  value: value as never,
});
const planOf = (contents: string | null, edits: JsonEdit[]) =>
  planJsonEdits(join(tempDir(), 'settings.json'), edits, { read: () => contents });

/**
 * A `json-set` records the value it replaced, so that undo can put it back. The record is a file
 * on the disk, and a replaced value that is a credential would make it one more place the
 * credential lives. Such a value is not recorded: the record says that there was one, and undo
 * says that it cannot put it back.
 */
describe('a json-set that replaces a credential', () => {
  it('records that there was a value, and not the value', () => {
    const plan = planOf(jsonText({ env: { API_TOKEN: FAKE_SECRET } }), [
      set(['env', 'API_TOKEN'], 'new-value'),
    ]);

    expect(plan.edits[0]).toMatchObject({
      kind: 'json-set',
      previous: { present: true, value: MASKED_PREVIOUS_VALUE, masked: true },
    });
    expect(JSON.stringify(plan.edits)).not.toContain(FAKE_SECRET);
  });

  it('tells the owner before they say yes that no copy of it will exist', () => {
    const plan = planOf(jsonText({ env: { API_TOKEN: FAKE_SECRET } }), [
      set(['env', 'API_TOKEN'], 'new-value'),
    ]);

    expect(plan.notices).toContain(REPLACED_CREDENTIAL_NOTICE);
  });

  it.each([
    [
      'a value under a name that says secret',
      { env: { API_TOKEN: FAKE_SECRET } },
      ['env', 'API_TOKEN'],
    ],
    [
      'a token of a known shape under any name',
      { note: 'ghp_0123456789abcdefghijklmnop' },
      ['note'],
    ],
    ['an object that holds one', { env: { API_TOKEN: FAKE_SECRET, PORT: '3000' } }, ['env']],
    ['a list that holds one', { tokens: [FAKE_SECRET] }, ['tokens']],
    ['a URL with a password in it', { url: 'postgres://u:pw12345@h.invalid/d' }, ['url']],
  ])('masks %s', (_name, before, path) => {
    const plan = planOf(jsonText(before), [set(path, 'replaced')]);

    expect(plan.edits[0]).toMatchObject({ previous: { masked: true } });
    expect(JSON.stringify(plan.edits)).not.toMatch(/stroq_attack_|ghp_0123|pw12345/);
  });

  it('keeps recording the value it replaces when that is not a credential', () => {
    const plan = planOf(jsonText({ sandbox: { enabled: false }, note: 'a' }), [
      set(['sandbox', 'enabled'], true),
      set(['note'], 'b'),
    ]);

    expect(plan.edits.map((edit) => edit.kind === 'json-set' && edit.previous)).toEqual([
      { present: true, value: false },
      { present: true, value: 'a' },
    ]);
    expect(plan.notices).not.toContain(REPLACED_CREDENTIAL_NOTICE);
  });

  it('records "nothing was there" as it did, and the Stroq value is recorded as it is', () => {
    const plan = planOf(jsonText({}), [set(['sandbox', 'enabled'], true)]);

    expect(plan.edits[0]).toMatchObject({
      previous: { present: false },
      value: true,
    });
  });
});

describe('undoing a json-set that replaced a credential', () => {
  const made = () =>
    planOf(jsonText({ env: { API_TOKEN: FAKE_SECRET } }), [set(['env', 'API_TOKEN'], 'new-value')]);

  it('leaves the value Stroq set where it is, and says why, without the old value', () => {
    const plan = made();

    const result = undoJsonEdits(plan.after, plan.edits);

    expect(result).toMatchObject({ outcome: 'edited', text: plan.after });
    const kept = result.outcome === 'edited' ? result.kept : [];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('env.API_TOKEN');
    expect(kept[0]).toContain('cannot be put back');
    expect(kept[0]).not.toContain(FAKE_SECRET);
    expect(kept[0]).not.toContain(MASKED_PREVIOUS_VALUE);
  });

  it('never writes the placeholder into the file as if it were the old value', () => {
    const plan = made();

    const result = undoJsonEdits(plan.after, plan.edits);

    const text = result.outcome === 'edited' ? result.text : '';
    expect(text).not.toContain(MASKED_PREVIOUS_VALUE);
    expect(JSON.parse(text)).toEqual({ env: { API_TOKEN: 'new-value' } });
  });

  it('still takes out the rest of the entries of the same apply', () => {
    const plan = planOf(jsonText({ env: { API_TOKEN: FAKE_SECRET } }), [
      set(['env', 'API_TOKEN'], 'new-value'),
      { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'a' },
    ]);

    const result = undoJsonEdits(plan.after, plan.edits);

    const text = result.outcome === 'edited' ? result.text : '';
    expect(JSON.parse(text)).toEqual({ env: { API_TOKEN: 'new-value' } });
  });
});

describe('the manifest and a json-set that replaced a credential', () => {
  it('is written without the credential in it, and reads back', async () => {
    const e = engine();
    const before = jsonText({ env: { API_TOKEN: FAKE_SECRET }, model: 'm' });
    const { real, result } = await applied(
      e,
      'settings.json',
      before,
      [set(['env', 'API_TOKEN'], 'new-value')],
      { acknowledgeCredentialLoss: true },
    );

    const manifestText = readFileSync(join(e.home, 'harden', 'manifest.json'), 'utf8');

    expect(manifestText).not.toContain(FAKE_SECRET);
    expect(readManifest(e.env).files[real]?.[0]?.edits[0]).toMatchObject({
      previous: { present: true, masked: true },
    });
    expect(result.backup?.stored).toBe(false);
  });

  it('is undone by leaving the new value, and the owner is told', async () => {
    const e = engine();
    const before = jsonText({ env: { API_TOKEN: FAKE_SECRET }, model: 'm' });
    const { real, path } = await applied(
      e,
      'settings.json',
      before,
      [set(['env', 'API_TOKEN'], 'new-value')],
      { acknowledgeCredentialLoss: true },
    );
    owner(path, (doc) => ({ ...doc, theirs: true }));

    const result = await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      env: { API_TOKEN: 'new-value' },
      theirs: true,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toContain('cannot be put back');
  });

  it('accepts the masked shape, and nothing else of that shape', async () => {
    const { env, file, manifestFile } = setup();
    const masked = entry({
      edits: [
        {
          kind: 'json-set',
          path: ['a'],
          value: 1,
          previous: { present: true, value: MASKED_PREVIOUS_VALUE, masked: true },
          createdFrom: 1,
        },
      ],
    });
    await writeManifest(env, { version: 2, files: { [file]: [masked] } });
    expect(readManifest(env).files[file]).toEqual([masked]);

    for (const previous of [
      { present: true, value: 1, masked: false },
      { present: true, value: 1, masked: 'yes' },
      { present: true, masked: true },
      { present: true, value: 1, masked: true, why: 'x' },
    ]) {
      plant(manifestFile, {
        version: 1,
        files: {
          [file]: [
            {
              ...masked,
              edits: [{ kind: 'json-set', path: ['a'], value: 1, previous, createdFrom: 1 }],
            },
          ],
        },
      });
      expect(thrownBy(() => readManifest(env))).toMatchObject({ code: 'manifest-invalid' });
    }
    await writeManifest(env, emptyManifest());
  });
});
