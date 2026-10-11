import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planTextBlock, undoTextBlock } from '../../src/harden/textblock.js';
import type { RecordedTextBlockEdit, TextBlockPlan } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const ID = 'cursorignore-secrets';
const LINES = ['.env', '.env.*', '**/*.pem'];
const BEGIN = `# >>> stroq harden: ${ID} >>>`;
const END = `# <<< stroq harden: ${ID} <<<`;

function plan(contents: string | null, lines: readonly string[] = LINES): TextBlockPlan {
  const file = join(tempDir(), '.cursorignore');
  return planTextBlock(file, { id: ID, lines }, { read: () => contents });
}

const recorded = (made: TextBlockPlan): RecordedTextBlockEdit => {
  const [edit] = made.edits;
  if (edit === undefined) throw new Error('the plan recorded no edit');
  return edit;
};

function undone(current: string, edit: RecordedTextBlockEdit) {
  const result = undoTextBlock(current, edit);
  if (result.outcome !== 'edited') throw new Error(`blocked: ${result.detail}`);
  return result;
}

describe('undoTextBlock: nothing changed since', () => {
  it.each([
    ['a file that ends with a newline', 'node_modules/\ndist/\n'],
    ['a file that does not end with one', 'node_modules/\ndist/'],
    ['a file that ends with a blank line', 'node_modules/\n\n'],
    ['a file that ends with a line of white space', 'a\n \t\n'],
    ['a CRLF file', 'a\r\nb\r\n'],
    ['an empty file', ''],
    [
      'a file with other blocks in it',
      '# >>> stroq harden: other >>>\nx\n# <<< stroq harden: other <<<\n',
    ],
  ])('gives back the same bytes for %s', (_name, before) => {
    const made = plan(before);

    const result = undone(made.after, recorded(made));

    expect(result.text).toBe(before);
    expect(result.kept).toEqual([]);
  });

  it('puts back the lines a block had before it was replaced', () => {
    const before = `top\n${BEGIN}\nold\n${END}\nbottom\n`;
    const made = plan(before, ['new']);

    const result = undone(made.after, recorded(made));

    expect(result.text).toBe(before);
  });

  it('says the text is empty once the block is out of a file Stroq made', () => {
    const made = plan(null);

    const result = undone(made.after, recorded(made));

    expect(result.text).toBe('');
    expect(result.empty).toBe(true);
  });

  it('does not say the text is empty when the owner’s lines are still in it', () => {
    const made = plan('mine\n');

    expect(undone(made.after, recorded(made)).empty).toBe(false);
  });
});

describe('undoTextBlock: the owner changed the file since', () => {
  it('takes out the block and keeps the lines the owner added around it', () => {
    const made = plan('node_modules/\n');
    const current = `first\n${made.after}last\n`;

    const result = undone(current, recorded(made));

    expect(result.text).toBe('first\nnode_modules/\nlast\n');
  });

  it('keeps the lines the owner added just before the block', () => {
    const made = plan('a\n');
    const current = made.after.replace('a\n', 'a\nmine\n');

    const result = undone(current, recorded(made));

    expect(result.text).toBe('a\nmine\n');
  });

  it('leaves the blank line before the block alone if the owner has changed what is before it', () => {
    const made = plan('a\n');
    // The owner deleted the blank line Stroq added: what is left before the block is theirs.
    const current = made.after.replace('a\n\n', 'a\n');

    const result = undone(current, recorded(made));

    expect(result.text).toBe('a\n');
  });

  it('leaves a block alone that the owner has edited, and says so', () => {
    const made = plan('a\n');
    const current = made.after.replace('.env.*', '.env.local');

    const result = undone(current, recorded(made));

    expect(result.text).toBe(current);
    expect(result.kept).toEqual([
      `${ID}: the block was edited since Stroq wrote it, so it was left as it is`,
    ]);
  });

  it('does nothing when the block has already gone', () => {
    const made = plan('a\n');

    const result = undone('a\nand something else\n', recorded(made));

    expect(result.text).toBe('a\nand something else\n');
    expect(result.kept).toEqual([]);
  });

  it('is the same when it is run again', () => {
    const made = plan('a\n');

    const once = undone(made.after, recorded(made));
    const twice = undone(once.text, recorded(made));

    expect(twice.text).toBe(once.text);
  });

  it('only touches the block with its own id', () => {
    const other = '# >>> stroq harden: other >>>\nkeep\n# <<< stroq harden: other <<<\n';
    const made = plan('a\n');
    const current = `${other}${made.after}`;

    expect(undone(current, recorded(made)).text).toBe(`${other}a\n`);
  });

  it('keeps the owner’s lines in CRLF form', () => {
    const made = plan('a\r\n');
    const current = `${made.after}mine\r\n`;

    expect(undone(current, recorded(made)).text).toBe('a\r\nmine\r\n');
  });
});

describe('undoTextBlock: a file it cannot edit safely', () => {
  it('does not touch a file whose markers are no longer a pair, and says why', () => {
    const made = plan('a\n');
    const damaged = made.after.replace(END, 'oops');

    const result = undoTextBlock(damaged, recorded(made));

    expect(result).toMatchObject({ outcome: 'blocked', refused: 'markers-damaged' });
  });

  it('does not touch a file with the block twice', () => {
    const made = plan('a\n');

    const result = undoTextBlock(`${made.after}${made.after}`, recorded(made));

    expect(result).toMatchObject({ outcome: 'blocked', refused: 'markers-damaged' });
  });
});
