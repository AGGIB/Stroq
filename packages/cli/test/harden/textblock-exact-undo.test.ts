import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import { planTextBlock, undoTextBlock } from '../../src/harden/textblock.js';
import type { RecordedTextBlockEdit, TextBlockPlan } from '../../src/harden/types.js';
import { engine, undo } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const ID = 'cursorignore-secrets';
const LINES = ['.env', '.env.*'];
const BEGIN = `# >>> stroq harden: ${ID} >>>`;
const END = `# <<< stroq harden: ${ID} <<<`;

function plan(contents: string | null): TextBlockPlan {
  return planTextBlock(
    join(tempDir(), '.cursorignore'),
    { id: ID, lines: LINES },
    { read: () => contents },
  );
}

const edit = (made: TextBlockPlan): RecordedTextBlockEdit => {
  const [first] = made.edits;
  if (first === undefined) throw new Error('the plan recorded no edit');
  return first;
};

function undone(text: string, recorded: RecordedTextBlockEdit): string {
  const result = undoTextBlock(text, recorded);
  if (result.outcome !== 'edited') throw new Error(`blocked: ${result.detail}`);
  return result.text;
}

/**
 * When Stroq appends a block it writes up to three things around it: the line break that ends
 * the owner's last line if it had none, a blank line to set the block off, and a line break after
 * the end marker. Undo takes away exactly what was written and nothing else; in particular it
 * never joins what the owner wrote after the block onto the line the block came after.
 */
describe('what apply records of the bytes it wrote around a block', () => {
  it.each([
    ['a file that ends in a line break', 'node_modules/\n', '\n', false, '\n'],
    ['a file that ends in a blank line', 'node_modules/\n\n', '', false, '\n'],
    ['a file with no line break at the end', 'node_modules/', '\n\n', true, '\n'],
    ['a last line of white space and no line break', 'a\n  ', '\n', true, '\n'],
    ['a file with nothing in it', '', '', false, '\n'],
    ['a file that is not there', null, '', false, '\n'],
    ['a CRLF file', 'a\r\nb\r\n', '\r\n', false, '\r\n'],
    ['a CRLF file with no line break at the end', 'a\r\nb', '\r\n\r\n', true, '\r\n'],
  ])('writes, for %s, the bytes recorded', (_name, before, prefix, closesLastLine, suffix) => {
    const recorded = edit(plan(before));

    expect(recorded).toMatchObject({ prefix, closesLastLine, suffix, previous: null });
  });

  it('records nothing around a block that replaced another where it stood', () => {
    const before = `top\n${BEGIN}\nold\n${END}\nbottom\n`;

    expect(edit(plan(before))).toMatchObject({ prefix: '', closesLastLine: false, suffix: '' });
  });

  it('records exactly what the file got: the bytes are in the text', () => {
    const before = 'node_modules/';
    const made = plan(before);
    const { prefix, suffix } = edit(made);

    expect(made.after).toBe(`${before}${prefix}${BEGIN}\n${LINES.join('\n')}\n${END}${suffix}`);
  });
});

describe('undoTextBlock: a file with no line break at the end', () => {
  const before = 'node_modules/\ndist/';

  it('gives back the same bytes when nothing came after the block', () => {
    const made = plan(before);

    expect(undone(made.after, edit(made))).toBe(before);
  });

  it('keeps what the owner wrote after the block on a line of its own', () => {
    const made = plan(before);

    expect(undone(`${made.after}mine\n`, edit(made))).toBe('node_modules/\ndist/\nmine\n');
  });

  it('does the same when the owner’s text has no line break at its end either', () => {
    const made = plan(before);

    expect(undone(`${made.after}mine`, edit(made))).toBe('node_modules/\ndist/\nmine');
  });

  it('does the same for several lines', () => {
    const made = plan(before);

    expect(undone(`${made.after}one\ntwo\n`, edit(made))).toBe('node_modules/\ndist/\none\ntwo\n');
  });

  it('keeps the owner’s lines before the block as well', () => {
    const made = plan(before);
    const current = made.after.replace('dist/', 'dist/\nmore/');

    expect(undone(`${current}mine\n`, edit(made))).toBe('node_modules/\ndist/\nmore/\nmine\n');
  });

  it('keeps a change the owner made to the last line, with the line break it needs', () => {
    const made = plan(before);
    const current = made.after.replace('dist/', 'build/');

    expect(undone(`${current}mine\n`, edit(made))).toBe('node_modules/\nbuild/\nmine\n');
    expect(undone(current, edit(made))).toBe('node_modules/\nbuild/');
  });

  it('leaves alone what is before the block when the owner has changed it so that the bytes are not there', () => {
    const made = plan(before);
    // The owner took out the blank line and kept the line break, so one break is left where two were.
    const current = made.after.replace('dist/\n\n', 'dist/\n');

    expect(undone(current, edit(made))).toBe('node_modules/\ndist/\n');
  });

  it('takes out the block and nothing else, when the owner’s last line now ends in a line break of its own', () => {
    const made = plan(before);
    // The owner added a line break after "dist/", before the two that Stroq wrote. Whose break is
    // whose cannot be told from the bytes, so none of them is taken away.
    const current = made.after.replace('dist/\n\n', 'dist/\n\n\n');

    expect(undone(current, edit(made))).toBe('node_modules/\ndist/\n\n\n');
  });

  it('leaves a block the owner edited in place, and keeps what the owner wrote after it', () => {
    const made = plan(before);
    const current = `${made.after.replace('.env.*', '.env.local')}mine\n`;

    const result = undoTextBlock(current, edit(made));

    expect(result).toMatchObject({ outcome: 'edited', text: current });
    expect(result.outcome === 'edited' && result.kept).toHaveLength(1);
  });
});

describe('undoTextBlock: a last line of white space and no line break', () => {
  const before = 'a\n  ';

  it('gives back the same bytes when nothing came after the block', () => {
    const made = plan(before);

    expect(undone(made.after, edit(made))).toBe(before);
  });

  it('ends that line for what the owner wrote after the block', () => {
    const made = plan(before);

    expect(undone(`${made.after}mine\n`, edit(made))).toBe('a\n  \nmine\n');
  });
});

describe('undoTextBlock: a file that ends in a line break', () => {
  const before = 'node_modules/\n';

  it('gives back the same bytes when nothing came after the block', () => {
    const made = plan(before);

    expect(undone(made.after, edit(made))).toBe(before);
  });

  it('keeps what the owner wrote after the block, directly after the owner’s last line', () => {
    const made = plan(before);

    expect(undone(`${made.after}mine\n`, edit(made))).toBe('node_modules/\nmine\n');
  });

  it('does the same when the owner’s text has no line break at its end', () => {
    const made = plan(before);

    expect(undone(`${made.after}mine`, edit(made))).toBe('node_modules/\nmine');
  });
});

describe('undoTextBlock: a CRLF file', () => {
  it('gives back the same bytes with no line break at the end, and with owner text after the block', () => {
    const before = 'a\r\nb';
    const made = plan(before);

    expect(undone(made.after, edit(made))).toBe(before);
    expect(undone(`${made.after}mine\r\n`, edit(made))).toBe('a\r\nb\r\nmine\r\n');
  });

  it('does the same for a CRLF file that ends in a line break', () => {
    const before = 'a\r\nb\r\n';
    const made = plan(before);

    expect(undone(made.after, edit(made))).toBe(before);
    expect(undone(`${made.after}mine\r\n`, edit(made))).toBe('a\r\nb\r\nmine\r\n');
  });
});

describe('undoTextBlock: a file that was empty, or not there', () => {
  it('goes back to nothing, and keeps what the owner wrote after the block', () => {
    const made = plan(null);

    expect(undone(made.after, edit(made))).toBe('');
    expect(undone(`${made.after}mine\n`, edit(made))).toBe('mine\n');
  });
});

describe('undo through the engine: what the owner wrote after the block is never joined to a line', () => {
  it('for a file with no line break at the end, byte for byte', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'node_modules/');
    const made = e.planBlock('.cursorignore');
    await applyPlan(made, e.env);
    const current = readFileSync(e.file('.cursorignore'), 'utf8');
    writeFileSync(e.file('.cursorignore'), `${current}mine\n`);

    const result = await undo(e, made.real);

    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('node_modules/\nmine\n');
    expect(result.status).toBe('surgical');
    expect(readManifest(e.env).files).toEqual({});
  });

  it('and back to the original when nothing was added, from the copy', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'node_modules/');
    const made = e.planBlock('.cursorignore');
    await applyPlan(made, e.env);

    const result = await undo(e, made.real);

    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('node_modules/');
    expect(result.status).toBe('restored');
  });

  it('through a record that was written to disk and read back', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'a\n  ');
    const made = e.planBlock('.cursorignore');
    await applyPlan(made, e.env);
    const recorded = readManifest(e.env).files[made.real]?.[0]?.edits[0];

    expect(recorded).toMatchObject({ prefix: '\n', closesLastLine: true, suffix: '\n' });
  });
});
