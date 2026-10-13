import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HIDDEN_LINE, unifiedDiff } from '../../src/harden/diff.js';
import { maskedDiff } from '../../src/harden/diff-mask.js';
import { engine } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * A repository writes the files the engine shows a diff of, and the paths too. A terminal obeys
 * the control sequences in what it is given: OSC 52 writes the clipboard, cursor movement paints a
 * fake verdict over the real one, a direction override shows a name reversed. The diff the engine
 * hands out is for printing, so what a repository put in it is made visible; the plain
 * `unifiedDiff` stays a faithful diff of the texts it is given.
 */
const OSC_52 = '\u001b]52;c;Zm9v\u0007';
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe('maskedDiff: lines a repository wrote', () => {
  it('shows an escape sequence in a context line as visible text', () => {
    const before = `keep\n${OSC_52}\nlast\n`;

    const { diff } = maskedDiff(before, `${before}more\n`, 'f.txt');

    expect(diff).not.toMatch(CONTROL);
    expect(diff).toContain('\\u001b]52;c;Zm9v\\u0007');
  });

  it('does the same in a line that is removed and in a line that is added', () => {
    const { diff } = maskedDiff(`a\n${OSC_52}\n`, `a\nb\u001b[2J\n`, 'f.txt');

    expect(diff).not.toMatch(CONTROL);
    expect(diff).toContain('-\\u001b]52;');
    expect(diff).toContain('+b\\u001b[2J');
  });

  it('covers the C1 controls and the direction overrides', () => {
    const { diff } = maskedDiff('a\n', 'a\n\u009b2J ‮evil⁦\n', 'f.txt');

    expect(diff).not.toMatch(CONTROL);
    expect(diff).toContain('\\u009b2J \\u202eevil\\u2066');
  });

  it('keeps a tab and a CRLF line break as they are', () => {
    const { diff } = maskedDiff('a\tb\r\nc\r\n', 'a\tb\r\nd\r\n', 'f.txt');

    expect(diff).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\tb\r\n-c\r\n+d\r\n');
  });

  it('makes a carriage return that is not part of a line break visible', () => {
    const { diff } = maskedDiff('a\n', 'a\nreal\rfake\n', 'f.txt');

    expect(diff).toContain('+real\\u000dfake');
  });

  it('still hides a line that holds a credential, next to a line that is made visible', () => {
    const after = `a\n${OSC_52}\nAPI_TOKEN=stroq_attack_fixture_value_0123456789\n`;

    const { diff, hidden } = maskedDiff('a\n', after, 'f.txt');

    expect(hidden).toBe(true);
    expect(diff).toContain(`+${HIDDEN_LINE}`);
    expect(diff).toContain('+\\u001b]52;c;Zm9v\\u0007');
    expect(diff).not.toContain('stroq_attack_fixture_value');
  });

  it('leaves ordinary text exactly as it was, whatever the language', () => {
    const { diff } = maskedDiff('a\n', 'a\nпривет, мир — é ✓ 🙂\n', 'f.txt');

    expect(diff).toContain('+привет, мир — é ✓ 🙂');
  });
});

describe('the label of a diff: a path a repository named', () => {
  it('has no C1 control and no direction override in it', () => {
    const out = unifiedDiff('a\n', 'b\n', { path: 'dir/\u009b2J‮fdp.json' });

    const [minus, plus] = out.split('\n');
    expect(minus).not.toMatch(CONTROL);
    expect(plus).not.toMatch(CONTROL);
  });

  it('still has no line break in it, which would end the header', () => {
    const out = unifiedDiff('a\n', 'b\n', { path: 'x\n+++ b/evil\u001b[31m' });

    expect(out.split('\n').slice(0, 2)).toHaveLength(2);
    expect(out).not.toContain('\u001b');
    expect(out.split('\n')[1]).toMatch(/^\+\+\+ b\/x\?/);
  });
});

describe.skipIf(process.platform === 'win32')('a plan for a file a repository wrote', () => {
  it('carries no escape sequence of the repository in its diff', () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), `*.log\n${OSC_52}`);

    const plan = e.planBlock('.cursorignore');

    expect(plan.changed).toBe(true);
    expect(plan.diff).not.toMatch(CONTROL);
    expect(plan.diff).toContain('\\u001b]52;c;Zm9v\\u0007');
  });
});
