import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { JsonPlan, Plan, TextBlockPlan } from '../../src/harden/types.js';
import { addDeny, engine, jsonText, undo } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

const MINIFIED = '{"permissions":{"deny":["a"]},"model":"m"}\n';

/** Nothing was written, kept or recorded. */
function expectUntouched(e: ReturnType<typeof engine>, name: string, text: string): void {
  expect(readFileSync(e.file(name), 'utf8')).toBe(text);
  expect(existsSync(join(e.home, 'harden'))).toBe(false);
  expect(existsSync(join(e.home, 'backups'))).toBe(false);
}

/** A plan as it comes back from a file: plain data, with nothing of the planner's in it. */
const plainData = <T extends Plan>(plan: T): T => JSON.parse(JSON.stringify(plan)) as T;

describe('applyPlan: a change that lays the whole file out again', () => {
  it('is not made unless the caller says it has agreed to that', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), MINIFIED);
    const plan = e.planJson('settings.json', [addDeny('b')]);
    expect(plan.formatting).toBe('will-change');

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
      code: 'reformat-not-acknowledged',
    });

    expectUntouched(e, 'settings.json', MINIFIED);
  });

  it('is not made when the caller says it has not', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), MINIFIED);
    const plan = e.planJson('settings.json', [addDeny('b')]);

    await expect(applyPlan(plan, e.env, { acknowledgeReformat: false })).rejects.toMatchObject({
      code: 'reformat-not-acknowledged',
    });

    expectUntouched(e, 'settings.json', MINIFIED);
  });

  it('is made when it has, and can be undone', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), MINIFIED);
    const plan = e.planJson('settings.json', [addDeny('b')]);

    const result = await applyPlan(plan, e.env, { acknowledgeReformat: true });

    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(e.file('settings.json'), 'utf8'))).toMatchObject({
      permissions: { deny: ['a', 'b'] },
      model: 'm',
    });
    await undo(e, plan.real);
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(MINIFIED);
  });

  it('is not made because a plan says it keeps the layout: the file is what decides', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), MINIFIED);
    const plan: JsonPlan = {
      ...e.planJson('settings.json', [addDeny('b')]),
      formatting: 'preserved',
    };

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({
      code: 'reformat-not-acknowledged',
    });

    expectUntouched(e, 'settings.json', MINIFIED);
  });

  it('asks nothing of a change that keeps the layout', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    const plan = e.planJson('settings.json', [addDeny('b')]);
    expect(plan.formatting).toBe('preserved');

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('asks nothing of a change that changes nothing, whatever the layout', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), MINIFIED);
    const plan = e.planJson('settings.json', [addDeny('a')]);
    expect(plan.formatting).toBe('will-change');
    expect(plan.changed).toBe(false);

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: false });

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(MINIFIED);
  });
});

describe('applyPlan: a file that would lose something in the trip through an object', () => {
  const lossy: [string, string][] = [
    ['a number past double precision', '{\n  "big": 12345678901234567890\n}\n'],
    ['a number out of range', '{\n  "huge": 1e400\n}\n'],
    ['a duplicated key', '{\n  "a": 1,\n  "a": 2\n}\n'],
    ['keys that look like numbers', '{\n  "b": 1,\n  "2": 2\n}\n'],
  ];

  it.each(lossy)('does not apply a plan that was refused for %s', async (_name, text) => {
    const e = engine();
    writeFileSync(e.file('settings.json'), text);
    const plan = e.planJson('settings.json', [addDeny('x')]);
    expect(plan.refused).toBe('lossy-json');

    await expect(applyPlan(plan, e.env, { acknowledgeReformat: true })).rejects.toMatchObject({
      code: 'plan-refused',
    });

    expectUntouched(e, 'settings.json', text);
  });

  // The refusal is the file’s, not the plan’s: a plan with the refusal taken out is refused again.
  it.each(lossy)(
    'refuses it for %s even from a plan that says nothing is wrong, and even when agreed to',
    async (_name, text) => {
      const e = engine();
      writeFileSync(e.file('settings.json'), text);
      const {
        refused: _refusal,
        refusedDetail: _detail,
        ...asked
      } = e.planJson('settings.json', [addDeny('x')]);
      const doctored: JsonPlan = {
        ...asked,
        after: text.replace(/\n}\n$/, ',\n  "permissions": {"deny": ["x"]}\n}\n'),
        changed: true,
        edits: [
          {
            kind: 'json-array-add',
            path: ['permissions', 'deny'],
            value: 'x',
            preexisting: false,
            createdFrom: 0,
          },
        ],
      };

      await expect(applyPlan(doctored, e.env, { acknowledgeReformat: true })).rejects.toMatchObject(
        { code: 'lossy-json' },
      );

      expectUntouched(e, 'settings.json', text);
    },
  );
});

describe('applyPlan: a plan is plain data, and its text after has to be what its edits make', () => {
  it('applies a plan that has been through JSON, as a plan read from a file is', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    const plan = plainData(e.planJson('settings.json', [addDeny('x')]));

    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
  });

  it('refuses a text after that has something more in it than the edits say', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [addDeny('x')]);
    const doctored: JsonPlan = {
      ...plan,
      after: jsonText({ model: 'm', permissions: { deny: ['x'] }, hooks: { evil: true } }),
    };

    await expect(applyPlan(doctored, e.env)).rejects.toMatchObject({ code: 'plan-inconsistent' });

    expectUntouched(e, 'settings.json', before);
  });

  it('refuses a text after with the same edits but one byte more', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan({ ...plan, after: `${plan.after} ` }, e.env)).rejects.toMatchObject({
      code: 'plan-inconsistent',
    });

    expectUntouched(e, 'settings.json', before);
  });

  it('refuses edits that do not make the text after', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan({ ...plan, edits: [] }, e.env)).rejects.toMatchObject({
      code: 'plan-inconsistent',
    });
    const other = e.planJson('settings.json', [addDeny('y')]);
    await expect(applyPlan({ ...plan, edits: other.edits }, e.env)).rejects.toMatchObject({
      code: 'plan-inconsistent',
    });

    expectUntouched(e, 'settings.json', before);
  });

  it('refuses edits that record something else than what the text after shows', async () => {
    const e = engine();
    const before = jsonText({ permissions: { deny: ['x'] } });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [addDeny('y')]);
    const [only] = plan.edits;
    if (only?.kind !== 'json-array-add') throw new Error('expected an array add');
    // Undo would leave the element in, because the record says it was the owner’s.
    const doctored: JsonPlan = { ...plan, edits: [{ ...only, preexisting: true }] };

    await expect(applyPlan(doctored, e.env)).rejects.toMatchObject({ code: 'plan-inconsistent' });

    expectUntouched(e, 'settings.json', before);
  });

  it('refuses a diff that does not show the change', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [addDeny('x')]);

    await expect(
      applyPlan(
        { ...plan, diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-nothing\n+nothing much\n' },
        e.env,
      ),
    ).rejects.toMatchObject({ code: 'plan-inconsistent' });

    expectUntouched(e, 'settings.json', before);
  });

  it('refuses a plan that says it changes something when its edits change nothing', async () => {
    const e = engine();
    const before = jsonText({ permissions: { deny: ['x'] } });
    writeFileSync(e.file('settings.json'), before);
    const nothing = e.planJson('settings.json', [addDeny('x')]);
    expect(nothing.changed).toBe(false);

    await expect(
      applyPlan({ ...nothing, changed: true, after: `${before} ` }, e.env),
    ).rejects.toMatchObject({ code: 'plan-inconsistent' });

    expectUntouched(e, 'settings.json', before);
  });

  describe('for a text block', () => {
    const block = (e: ReturnType<typeof engine>, text: string): TextBlockPlan => {
      writeFileSync(e.file('.cursorignore'), text);
      return e.planBlock('.cursorignore');
    };

    it('applies a faithful plan, plain data or not', async () => {
      const e = engine();
      const plan = plainData(block(e, 'node_modules/\n'));

      await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
    });

    it('refuses a text after with something more in it', async () => {
      const e = engine();
      const plan = block(e, 'node_modules/\n');

      await expect(
        applyPlan({ ...plan, after: `${plan.after}!/important\n` }, e.env),
      ).rejects.toMatchObject({ code: 'plan-inconsistent' });

      expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('node_modules/\n');
    });

    it('refuses bytes recorded around the block that are not the bytes in the text', async () => {
      const e = engine();
      const plan = block(e, 'node_modules/\n');
      const [only] = plan.edits;
      if (only === undefined) throw new Error('expected an edit');
      const doctored: TextBlockPlan = { ...plan, edits: [{ ...only, prefix: '\n\n\n' }] };

      await expect(applyPlan(doctored, e.env)).rejects.toMatchObject({ code: 'plan-inconsistent' });

      expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('node_modules/\n');
    });

    it('refuses a plan with no edit, or two', async () => {
      const e = engine();
      const plan = block(e, 'node_modules/\n');
      const [only] = plan.edits;
      if (only === undefined) throw new Error('expected an edit');

      await expect(applyPlan({ ...plan, edits: [] }, e.env)).rejects.toMatchObject({
        code: 'plan-inconsistent',
      });
      await expect(applyPlan({ ...plan, edits: [only, only] }, e.env)).rejects.toMatchObject({
        code: 'plan-inconsistent',
      });
    });
  });

  it('did not record anything for the plans it refused', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    const plan = e.planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan({ ...plan, after: `${plan.after} ` }, e.env)).rejects.toBeDefined();

    expect(readManifest(e.env).files).toEqual({});
  });
});
