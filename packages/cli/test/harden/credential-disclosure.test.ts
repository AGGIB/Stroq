import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCredentialShape } from '../../src/harden/backup.js';
import { hiddenLineMask } from '../../src/harden/credential-shape.js';
import { applyPlan, undoFile } from '../../src/harden/index.js';
import { REPLACED_CREDENTIAL_NOTICE } from '../../src/harden/json-edit.js';
import { verifyPlan } from '../../src/harden/replay.js';
import { blockMarkers } from '../../src/harden/textblock.js';
import { addDeny, engine, IGNORE_ID, jsonText } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

describe('wrapped credential assignments', () => {
  it.each([
    'Bash(PGPASSWORD=hunter2 psql -h db:*)',
    'Bash(API_TOKEN=abcd1234efgh:*)',
    '$(TOKEN=abcd1234efgh cmd)',
    'MCP(API_TOKEN=abcd1234efgh)',
  ])('finds and hides %s in a permission rule', (rule) => {
    const text = jsonText({ permissions: { allow: [rule] } });
    const mask = hiddenLineMask(text);
    expect(findCredentialShape(text)).toBe('named-secret');
    expect(text.split('\n').some((line, i) => line.includes(rule) && mask(i, line))).toBe(true);
  });

  it.each([
    'Bash(API_TOKEN=${API_TOKEN} cmd)',
    'Bash(API_TOKEN=your-key cmd)',
    'https://example.invalid/API_TOKEN=abcd1234efgh',
    `Bash(${'X'.repeat(129)}TOKEN=abcd1234efgh cmd)`,
  ])('keeps placeholders, URL paths and oversized names quiet: %s', (text) => {
    expect(findCredentialShape(jsonText({ rule: text }))).toBeNull();
  });
});

describe('commented credentials', () => {
  it.each([
    '# API_TOKEN=abcd1234efgh',
    '#API_KEY=abcdefghijklmnop',
    '; password = hunter2hunter2',
    '# old: DB_PASSWORD=Zq7Zq7Zq7Zq7',
    '  # password: hunter2hunter2',
  ])('refuses to persist a replaced block containing %s', async (line) => {
    const e = engine();
    const { begin, end } = blockMarkers(IGNORE_ID);
    const before = `${begin}\n${line}\n${end}\n`;
    writeFileSync(e.file('.cursorignore'), before);
    const plan = e.planBlock('.cursorignore');
    expect(findCredentialShape(line)).toBe('named-secret');
    expect(plan.refused).toBe('credential-in-block');
    expect(plan.edits).toEqual([]);
    expect(plan.backup).toBe('none-credential-text');
    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'plan-refused' });
    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe(before);
    expect(existsSync(join(e.home, 'harden'))).toBe(false);
    expect(existsSync(join(e.home, 'backups'))).toBe(false);
  });

  it.each(['# API_TOKEN=your-key', '# API_TOKEN=<token>', '; password = xxx', '# TOKEN=${TOKEN}'])(
    'keeps a commented placeholder quiet: %s',
    (line) => expect(findCredentialShape(line)).toBeNull(),
  );
});

describe.skipIf(process.platform === 'win32')('linked target preview', () => {
  it('withholds all text context until the caller acknowledges the target', async () => {
    const e = engine();
    const secret = 'WEBHOOK=https://hooks.slack.com/services/T0/B0/abcdefgh';
    writeFileSync(e.file('.env'), `${secret}\nOPENAI=sk_x\n`);
    symlinkSync(e.file('.env'), e.file('.cursorignore'));
    const hidden = e.planBlock('.cursorignore');
    expect(hidden.diff).toBe('');
    expect(hidden.notices.join(' ')).toContain('withheld');
    expect(() => verifyPlan(hidden)).not.toThrow();
    await expect(applyPlan(hidden, e.env)).rejects.toMatchObject({ code: 'link-not-acknowledged' });
    const shown = e.planBlock('.cursorignore', ['.env'], { acknowledgeLink: true });
    expect(shown.diff).toContain(secret);
    expect(() => verifyPlan(shown)).not.toThrow();
    await expect(applyPlan(shown, e.env)).rejects.toMatchObject({ code: 'link-not-acknowledged' });
    await expect(applyPlan(shown, e.env, { acknowledgeLink: true })).resolves.toMatchObject({
      changed: true,
    });
  });

  it.each([false, true])(
    'withholds removed lines and additions derived from JSON layout (minified=%s)',
    (minified) => {
      const e = engine();
      const original = {
        WEBHOOK: 'https://hooks.slack.com/services/T0/B0/abcdefgh',
        OPENAI: 'sk_x',
      };
      writeFileSync(
        e.file('secrets.json'),
        minified ? JSON.stringify(original) : jsonText(original),
      );
      symlinkSync(e.file('secrets.json'), e.file('settings.json'));
      const hidden = e.planJson('settings.json', [addDeny('Read(.env)')]);
      expect(hidden.diff).toBe('');
      expect(() => verifyPlan(hidden)).not.toThrow();
      const shown = e.planJson('settings.json', [addDeny('Read(.env)')], { acknowledgeLink: true });
      expect(shown.diff).toContain(original.OPENAI);
      expect(() => verifyPlan(shown)).not.toThrow();
    },
  );
});

describe('an unchanged json-set alongside a real edit', () => {
  it('records no credential, needs no loss acknowledgement and undoes without a false warning', async () => {
    const e = engine();
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const before = jsonText({ env: { ANTHROPIC_API_KEY: secret } });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [
      { kind: 'json-set', path: ['env', 'ANTHROPIC_API_KEY'], value: secret },
      addDeny('Read(.env)'),
    ]);
    expect(plan.edits).toHaveLength(1);
    expect(JSON.stringify(plan.edits)).not.toContain(secret);
    expect(plan.notices).not.toContain(REPLACED_CREDENTIAL_NOTICE);
    await expect(applyPlan(plan, e.env)).resolves.toMatchObject({ changed: true });
    expect(readFileSync(join(e.home, 'harden', 'manifest.json'), 'utf8')).not.toContain(secret);
    const undone = await undoFile(e.env, plan.real, { root: e.project });
    expect(undone.kept).toEqual([]);
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(before);
  });
});
