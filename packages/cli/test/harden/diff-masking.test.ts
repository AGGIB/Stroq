import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIFF_HIDDEN_NOTICE, maskedDiff } from '../../src/harden/diff-mask.js';
import { HIDDEN_LINE, unifiedDiff } from '../../src/harden/diff.js';
import { applyPlan } from '../../src/harden/index.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { planTextBlock } from '../../src/harden/textblock.js';
import type { JsonEdit } from '../../src/harden/types.js';
import {
  addDeny,
  applied,
  engine,
  IGNORE_ID,
  jsonText,
  owner,
  setSandbox,
  undo,
} from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * A diff is printed, and when an agent ran the command it is read by the agent's model: it is a
 * channel that values leave in. Around a change to a file that holds a credential, the context
 * lines can be the line a token is on.
 */
const SECRET = 'stroq_attack_fixture_value_0123456789';
const OTHER = 'stroq_attack_fixture_value_9876543210';

const planOf = (contents: string | null, edits: readonly JsonEdit[]) =>
  planJsonEdits(join(tempDir(), 'settings.json'), edits, { read: () => contents });

describe('a plan’s diff, when the file holds a credential', () => {
  it('shows the line a credential is on as a placeholder, and says so', () => {
    const before = jsonText({ env: { API_TOKEN: SECRET }, model: 'm' });

    const plan = planOf(before, [addDeny('Read(~/.ssh/**)')]);

    expect(plan.diff).not.toContain(SECRET);
    expect(plan.diff).toContain(` ${HIDDEN_LINE}`);
    expect(plan.diff).toContain('Read(~/.ssh/**)');
    expect(plan.notices).toContain(DIFF_HIDDEN_NOTICE);
  });

  it('keeps the other lines of the diff, so that the change can still be reviewed', () => {
    const before = jsonText({ env: { API_TOKEN: SECRET }, model: 'm' });

    const plan = planOf(before, [addDeny('Read(~/.ssh/**)')]);

    expect(plan.diff).toContain('"env": {');
    expect(plan.diff).toContain('"model": "m"');
    expect(plan.diff).toContain('+  "permissions": {');
  });

  it('only hides lines: the plan still applies the text it says, secret included', () => {
    const before = jsonText({ env: { API_TOKEN: SECRET }, model: 'm' });

    const plan = planOf(before, [addDeny('x')]);

    expect(plan.before).toBe(before);
    expect(JSON.parse(plan.after)).toMatchObject({ env: { API_TOKEN: SECRET } });
  });

  it('hides both the old and the new line of a credential that is replaced', () => {
    const before = jsonText({ env: { API_TOKEN: SECRET } });

    const plan = planOf(before, [{ kind: 'json-set', path: ['env', 'API_TOKEN'], value: OTHER }]);

    expect(plan.diff).not.toContain(SECRET);
    expect(plan.diff).not.toContain(OTHER);
    expect(plan.diff).toContain(`-${HIDDEN_LINE}`);
    expect(plan.diff).toContain(`+${HIDDEN_LINE}`);
  });

  it('hides an item of a list that hangs under a name that says secret, which no line shows by itself', () => {
    const before = jsonText({ tokens: ['hunter2hunter2hunter2'], note: 'x' });

    const plan = planOf(before, [addDeny('a')]);

    expect(plan.diff).not.toContain('hunter2');
    expect(plan.diff).toContain(HIDDEN_LINE);
  });

  it('hides the value after a secret flag, and leaves the flag', () => {
    const before = jsonText({ args: ['--password', 'hunter2hunter2'], model: 'm' });

    const plan = planOf(before, [addDeny('a')]);

    expect(plan.diff).not.toContain('hunter2');
    expect(plan.diff).toContain('"--password",');
  });

  it.each([
    ['a bearer token', jsonText({ headers: { Authorization: `Bearer ${SECRET}` } })],
    ['a URL with a password', jsonText({ url: `postgres://app:${SECRET}@db.invalid/app` })],
    ['a vendor token', jsonText({ note: 'ghp_0123456789abcdefghijklmnop' })],
    ['a card number', jsonText({ note: 'card 4242 4242 4242 4242' })],
  ])('hides %s', (_name, before) => {
    const plan = planOf(before, [addDeny('a')]);

    expect(plan.diff).toContain(HIDDEN_LINE);
    expect(plan.diff).not.toMatch(/ghp_0123|4242 4242|stroq_attack_/);
  });

  it('hides the body of a private key in a plain text file, which is only base64 and shows nothing by itself', () => {
    const body = 'MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3S';
    const before = `# keys\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n# the end\n`;
    const file = join(tempDir(), 'notes');

    const plan = planTextBlock(file, { id: IGNORE_ID, lines: ['.env'] }, { read: () => before });

    expect(plan.diff).toContain(HIDDEN_LINE);
    expect(plan.diff).not.toContain(body);
    expect(plan.diff).not.toContain('END PRIVATE KEY');
    expect(plan.diff).toContain(' # the end');
    expect(plan.notices).toContain(DIFF_HIDDEN_NOTICE);
  });

  it('hides a line too long to be read for credentials, which could hold one', () => {
    const before = `# keep\n# ${'x'.repeat(5000)}\nnode_modules/\n`;
    const file = join(tempDir(), 'ignore');

    const plan = planTextBlock(file, { id: IGNORE_ID, lines: ['.env'] }, { read: () => before });

    expect(plan.diff).not.toContain('xxxxxxxxxx');
    expect(plan.diff).toContain(HIDDEN_LINE);
  });

  it('hides the credential line of an env-style file that a block is added to', () => {
    const before = `PORT=3000\nAPI_TOKEN=${SECRET}\n`;
    const file = join(tempDir(), '.cursorignore');

    const plan = planTextBlock(file, { id: IGNORE_ID, lines: ['.env'] }, { read: () => before });

    expect(plan.diff).not.toContain(SECRET);
    expect(plan.diff).toContain(' PORT=3000');
    expect(plan.notices).toEqual([
      'no byte backup: the file holds credential-shaped text',
      DIFF_HIDDEN_NOTICE,
    ]);
  });
});

describe('a plan’s diff, when the file holds none', () => {
  it('is the diff it always was, with no placeholder and no notice', () => {
    const before = jsonText({ model: 'm', permissions: { deny: ['a'] } });

    const plan = planOf(before, [addDeny('b')]);

    expect(plan.diff).toBe(unifiedDiff(before, plan.after, { path: plan.file }));
    expect(plan.diff).not.toContain(HIDDEN_LINE);
    expect(plan.notices).toEqual([]);
  });

  it('does not say it hid something when the credential is too far from the change to be in the diff', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `# filler ${i}`);
    const before = `API_TOKEN=${SECRET}\n${rows.join('\n')}\n`;
    const file = join(tempDir(), 'ignore');

    const plan = planTextBlock(file, { id: IGNORE_ID, lines: ['.env'] }, { read: () => before });

    expect(plan.diff).not.toContain(HIDDEN_LINE);
    expect(plan.notices).toEqual(['no byte backup: the file holds credential-shaped text']);
  });
});

describe('maskedDiff', () => {
  it('treats a file that is not there as an empty one, with the header git uses', () => {
    const result = maskedDiff(null, '{"a":1}\n', 'x.json');

    expect(result.diff.split('\n')[0]).toBe('--- /dev/null');
    expect(result.hidden).toBe(false);
  });

  it('looks at the new text as well as the old: a credential that is being added is hidden too', () => {
    const result = maskedDiff('a\n', `a\nAPI_TOKEN=${SECRET}\n`, 'x');

    expect(result.diff).not.toContain(SECRET);
    expect(result.hidden).toBe(true);
  });
});

describe('an undo’s diff, when the file holds a credential', () => {
  it('hides the line, and says so in the result', async () => {
    const e = engine();
    const before = jsonText({ env: { API_TOKEN: SECRET }, model: 'm' });
    const { real, result: made } = await applied(e, 'settings.json', before, [
      addDeny('Read(~/.ssh/**)'),
      setSandbox(true),
    ]);
    expect(made.backup?.stored).toBe(false);
    owner(e.file('settings.json'), (doc) => ({ ...doc, theirs: true }));

    const result = await undo(e, real);

    expect(result.status).toBe('surgical');
    expect(result.diff).not.toContain(SECRET);
    expect(result.diff).toContain(HIDDEN_LINE);
    expect(result.notices).toContain(DIFF_HIDDEN_NOTICE);
  });

  it('is the diff it always was for a file with none', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);

    const result = await undo(e, real);

    expect(result.diff).not.toContain(HIDDEN_LINE);
    expect(result.notices).toEqual([]);
  });

  it('applies a plan whose diff was hidden: the apply itself is unchanged', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ env: { API_TOKEN: SECRET } }));
    const plan = e.planJson('settings.json', [addDeny('a')]);

    const result = await applyPlan(plan, e.env);

    expect(result.changed).toBe(true);
    expect(result.diff).toBe(plan.diff);
    expect(result.diff).not.toContain(SECRET);
  });
});
