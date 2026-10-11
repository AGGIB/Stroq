import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import { blockMarkers } from '../../src/harden/textblock.js';
import { IGNORE_ID, engine } from './engine-setup.js';
import { FAKE_SECRET } from './manifest-fixtures.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * The lines between Stroq's markers are recorded when the block is replaced, so that undo can put
 * them back, and the record is a file. A line a person left in there that looks like a credential
 * would be copied into it. So a block like that is not replaced: the plan is refused, and says
 * which block and why (never the line), and the owner takes the line out.
 */
const { begin, end } = blockMarkers(IGNORE_ID);
const file = (body: readonly string[], outside: readonly string[] = []): string =>
  `${[...outside, '# project', '', begin, ...body, end, ''].join('\n')}`;
const NEW_LINES = ['.env', '.env.*', '*.key'];
const TOKEN_LINE = `API_TOKEN=${FAKE_SECRET}`;

function planned(text: string, lines: readonly string[] = NEW_LINES) {
  const e = engine();
  writeFileSync(e.file('.cursorignore'), text);
  return { e, plan: e.planBlock('.cursorignore', lines) };
}

describe('planTextBlock: a block with a credential in it', () => {
  it('is not replaced: the plan is refused, and nothing is recorded', () => {
    const { plan } = planned(file(['.env', TOKEN_LINE]));

    expect(plan.refused).toBe('credential-in-block');
    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(plan.before);
    expect(plan.diff).toBe('');
    expect(plan.edits).toEqual([]);
  });

  it('names the block and never the line', () => {
    const { plan } = planned(file(['.env', TOKEN_LINE]));

    expect(plan.refusedDetail).toContain(IGNORE_ID);
    expect(plan.refusedDetail).not.toContain(FAKE_SECRET);
    expect(plan.diff).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(plan.notices)).not.toContain(FAKE_SECRET);
  });

  it('cannot be applied, and the file and the record are left as they were', async () => {
    const text = file(['.env', TOKEN_LINE]);
    const { e, plan } = planned(text);

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'plan-refused' });

    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe(text);
    expect(readManifest(e.env).files).toEqual({});
  });

  it('is refused for a line that is too long to be checked, which is not the same as clean', () => {
    const { plan } = planned(file(['.env', 'x'.repeat(5000)]));

    expect(plan.refused).toBe('credential-in-block');
  });

  it('is replaced again once the person has taken the line out', () => {
    const { plan } = planned(file(['.env']));

    expect(plan.refused).toBeUndefined();
    expect(plan.changed).toBe(true);
    expect(plan.edits[0]).toMatchObject({ previous: ['.env'] });
  });
});

describe('planTextBlock: a credential that is not in the block', () => {
  it('does not stop the block being replaced, and is not recorded', () => {
    const { plan } = planned(file(['.env'], [TOKEN_LINE]));

    expect(plan.refused).toBeUndefined();
    expect(plan.changed).toBe(true);
    expect(plan.backup).toBe('none-credential-text');
    expect(JSON.stringify(plan.edits)).not.toContain(FAKE_SECRET);
  });

  it('does not stop a block being added to a file that holds one', () => {
    const { plan } = planned(`${TOKEN_LINE}\n`);

    expect(plan.refused).toBeUndefined();
    expect(plan.edits[0]).toMatchObject({ previous: null });
    expect(JSON.stringify(plan.edits)).not.toContain(FAKE_SECRET);
  });

  it('does not stop a block whose lines are the lines asked for: nothing is replaced', () => {
    const { plan } = planned(file([TOKEN_LINE]), [TOKEN_LINE]);

    expect(plan.refused).toBeUndefined();
    expect(plan.changed).toBe(false);
  });
});
