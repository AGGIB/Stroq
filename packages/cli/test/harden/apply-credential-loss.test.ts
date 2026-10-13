import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { JsonEdit } from '../../src/harden/types.js';
import { FAKE_SECRET } from './manifest-fixtures.js';
import { addDeny, engine, jsonText, setSandbox } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * Replacing a value that looks like a credential cannot be taken back: no copy of the file is kept
 * (it would be one more place the credential lives) and the record holds a placeholder. That is
 * the owner's call, and a notice in a plan is something a caller can fail to print. So, like a
 * change that lays the whole file out again, it needs the caller's word that the owner was told.
 */
const replaceToken: JsonEdit = { kind: 'json-set', path: ['env', 'API_TOKEN'], value: 'new-value' };
const withToken = jsonText({ env: { API_TOKEN: FAKE_SECRET }, model: 'm' });

function planned(edits: readonly JsonEdit[] = [replaceToken], text = withToken) {
  const e = engine();
  writeFileSync(e.file('settings.json'), text);
  return { e, path: e.file('settings.json'), plan: e.planJson('settings.json', edits) };
}

describe('applyPlan: a json-set that replaces a credential', () => {
  it('is refused until the caller says the owner knows it cannot be put back', async () => {
    const { e, path, plan } = planned();

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
      code: 'credential-loss-not-acknowledged',
    });

    expect(readFileSync(path, 'utf8')).toBe(withToken);
    expect(readManifest(e.env).files).toEqual({});
    expect(existsSync(join(e.home, 'backups')) ? readdirSync(join(e.home, 'backups')) : []).toEqual(
      [],
    );
  });

  it('says what will happen, and never what the value was', async () => {
    const { e, plan } = planned();

    const error = await applyPlan(plan, e.env).catch((err: unknown) => err);

    expect((error as Error).message).toContain('cannot be put back');
    expect((error as Error).message).not.toContain(FAKE_SECRET);
  });

  it('goes ahead once it is told, and the record holds the placeholder and not the value', async () => {
    const { e, path, plan } = planned();

    const result = await applyPlan(plan, e.env, { acknowledgeCredentialLoss: true });

    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      env: { API_TOKEN: 'new-value' },
    });
    expect(readFileSync(join(e.home, 'harden', 'manifest.json'), 'utf8')).not.toContain(
      FAKE_SECRET,
    );
  });

  it('is refused when it is one of several edits of one plan', async () => {
    const { e, plan } = planned([addDeny('a'), replaceToken]);

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
      code: 'credential-loss-not-acknowledged',
    });
  });

  it('is asked for after the reformat, and each needs its own word', async () => {
    const minified = `${JSON.stringify({ env: { API_TOKEN: FAKE_SECRET } })}\n`;
    const { e, plan } = planned([replaceToken], minified);

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
      code: 'reformat-not-acknowledged',
    });
    await expect(applyPlan(plan, e.env, { acknowledgeReformat: true })).rejects.toMatchObject({
      code: 'credential-loss-not-acknowledged',
    });
    await expect(
      applyPlan(plan, e.env, { acknowledgeReformat: true, acknowledgeCredentialLoss: true }),
    ).resolves.toMatchObject({ changed: true });
  });
});

describe('applyPlan: changes that do not replace a credential', () => {
  it('needs nothing to add a rule to a file that holds a credential somewhere else', async () => {
    const { e, plan } = planned([addDeny('Read(./.env)')]);

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('needs nothing to set a value that was not a credential', async () => {
    const { e, plan } = planned([setSandbox(true)], jsonText({ sandbox: { enabled: false } }));

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('needs nothing to set a value where there was none', async () => {
    const { e, plan } = planned([{ kind: 'json-set', path: ['env', 'NEW_TOKEN'], value: 'x' }]);

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('needs nothing to put back the same credential: nothing is replaced', async () => {
    const same: JsonEdit = { kind: 'json-set', path: ['env', 'API_TOKEN'], value: FAKE_SECRET };
    const { e, plan } = planned([same]);

    expect(plan.changed).toBe(false);
    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: false });
  });

  it('needs nothing for a block of lines in a file that holds a credential', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), `API_TOKEN=${FAKE_SECRET}\n`);

    await expect(applyPlan(e.planBlock('.cursorignore'), e.env)).resolves.toMatchObject({
      changed: true,
    });
  });
});
