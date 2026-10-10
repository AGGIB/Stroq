import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/harden/diff.js';
import { blockMarkers, planTextBlock } from '../../src/harden/textblock.js';
import { HardenError, type PlanOptions, type TextBlockPlan } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const ID = 'cursorignore-secrets';
const LINES = ['.env', '.env.*', '**/*.pem'];
const BEGIN = `# >>> stroq harden: ${ID} >>>`;
const END = `# <<< stroq harden: ${ID} <<<`;
const block = (lines: readonly string[] = LINES, eol = '\n'): string =>
  [BEGIN, ...lines, END].map((row) => `${row}${eol}`).join('');

function plan(
  contents: string | null,
  lines: readonly string[] = LINES,
  extra: Partial<PlanOptions> = {},
  id = ID,
): TextBlockPlan {
  const file = join(tempDir(), '.cursorignore');
  return planTextBlock(file, { id, lines }, { read: () => contents, ...extra });
}

describe('blockMarkers', () => {
  it('writes the markers the way the design names them', () => {
    expect(blockMarkers(ID)).toEqual({ begin: BEGIN, end: END });
  });
});

describe('planTextBlock: adding a block', () => {
  it('puts it at the end of the file, a blank line after what is there', () => {
    const before = 'node_modules/\ndist/\n';

    const result = plan(before);

    expect(result.after).toBe(`${before}\n${block()}`);
    expect(result.changed).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.kind).toBe('text-block');
    expect(result.diff).toBe(unifiedDiff(before, result.after, { path: result.file }));
    expect(result.edits).toEqual([
      { kind: 'text-block', id: ID, lines: LINES, previous: null, prefix: '\n' },
    ]);
  });

  it('ends the last line of a file that did not end its last line, then leaves the blank line', () => {
    const result = plan('node_modules/');

    expect(result.after).toBe(`node_modules/\n\n${block()}`);
    expect(result.edits[0]).toMatchObject({ prefix: '\n\n' });
  });

  it('does not add a second blank line to a file that already ends with one', () => {
    const before = 'node_modules/\n\n';

    const result = plan(before);

    expect(result.after).toBe(`${before}${block()}`);
    expect(result.edits[0]).toMatchObject({ prefix: '' });
  });

  it('counts a last line of only white space as the blank line', () => {
    const before = 'a\n  \t\n';

    expect(plan(before).after).toBe(`${before}${block()}`);
  });

  it('writes the block alone to a file that is not there, or is empty', () => {
    const missing = plan(null);
    expect(missing.after).toBe(block());
    expect(missing.existed).toBe(false);
    expect(missing.diff.split('\n')[0]).toBe('--- /dev/null');
    expect(missing.backup).toBe('none-new-file');
    expect(missing.edits[0]).toMatchObject({ prefix: '' });

    const empty = plan('');
    expect(empty.after).toBe(block());
    expect(empty.existed).toBe(true);
    expect(empty.backup).toBe('copy');
  });

  it('keeps blank lines inside the block', () => {
    const lines = ['.env', '', '# keys', '*.pem'];

    expect(plan('a\n', lines).after).toBe(`a\n\n${block(lines)}`);
  });

  it('writes an empty block as the two markers', () => {
    expect(plan(null, []).after).toBe(`${BEGIN}\n${END}\n`);
  });

  it('writes CRLF line endings to a file that has them, and only them', () => {
    const before = 'node_modules/\r\ndist/\r\n';

    const result = plan(before);

    expect(result.after).toBe(`${before}\r\n${block(LINES, '\r\n')}`);
    expect(result.after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(result.edits[0]).toMatchObject({ prefix: '\r\n' });
  });

  it('follows the first line ending of a file that has both', () => {
    expect(plan('a\nb\r\n').after.endsWith(block())).toBe(true);
    expect(plan('a\r\nb\n').after.endsWith(block(LINES, '\r\n'))).toBe(true);
  });
});

describe('planTextBlock: a block that is already there', () => {
  const before = `top\n\n${block()}bottom\n`;

  it('is replaced where it stands, and nothing outside the markers is touched', () => {
    const result = plan(before, ['.env', 'secrets/']);

    expect(result.after).toBe(`top\n\n${block(['.env', 'secrets/'])}bottom\n`);
    expect(result.edits).toEqual([
      { kind: 'text-block', id: ID, lines: ['.env', 'secrets/'], previous: LINES, prefix: '' },
    ]);
  });

  it('changes nothing when the lines are the same, not a byte', () => {
    const result = plan(before, LINES);

    expect(result.after).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.diff).toBe('');
    expect(result.edits[0]).toMatchObject({ previous: LINES });
  });

  it('is found with trailing white space on its marker lines, which editors add and remove', () => {
    const edited = before.replace(BEGIN, `${BEGIN}  `).replace(END, `${END}\t`);

    const result = plan(edited, ['only']);

    expect(result.after).toBe(`top\n\n${block(['only'])}bottom\n`);
  });

  it('keeps the lack of a newline at the end of a file that ends with the block', () => {
    const bare = `top\n${BEGIN}\n.env\n${END}`;

    expect(plan(bare, ['x']).after).toBe(`top\n${BEGIN}\nx\n${END}`);
  });

  it('leaves another block, with another id, as it is', () => {
    const other = '# >>> stroq harden: other >>>\nkeep\n# <<< stroq harden: other <<<\n';
    const both = `${other}\n${block()}`;

    const result = plan(both, ['new']);

    expect(result.after).toBe(`${other}\n${block(['new'])}`);
  });

  it('does not take a line that only contains a marker for the marker', () => {
    const lookalike = `x ${BEGIN}\n${BEGIN} extra\n`;

    const result = plan(lookalike);

    expect(result.after).toBe(`${lookalike}\n${block()}`);
    expect(result.edits[0]).toMatchObject({ previous: null });
  });

  it('replaces a block in a CRLF file with CRLF lines', () => {
    const crlf = `top\r\n\r\n${block(LINES, '\r\n')}bottom\r\n`;

    expect(plan(crlf, ['x']).after).toBe(`top\r\n\r\n${block(['x'], '\r\n')}bottom\r\n`);
  });

  it('ignores an end marker with no begin marker before it', () => {
    const stray = `${END}\nfoo\n`;

    expect(plan(stray).after).toBe(`${stray}\n${block()}`);
  });
});

describe('planTextBlock: markers it will not guess about', () => {
  it('refuses a begin marker with no end marker after it', () => {
    const broken = `top\n${BEGIN}\n.env\nbottom\n`;

    const result = plan(broken);

    expect(result.refused).toBe('markers-damaged');
    expect(result.after).toBe(broken);
    expect(result.changed).toBe(false);
    expect(result.edits).toEqual([]);
    expect(result.refusedDetail).toMatch(/end marker/);
  });

  it('refuses a block that appears twice', () => {
    const twice = `${block()}\n${block()}`;

    const result = plan(twice);

    expect(result.refused).toBe('markers-damaged');
    expect(result.after).toBe(twice);
    expect(result.refusedDetail).toMatch(/more than once/);
  });

  it('refuses text that was not valid UTF-8', () => {
    const result = plan('caf\u{FFFD}\n');

    expect(result.refused).toBe('not-utf8');
    expect(result.changed).toBe(false);
  });
});

describe('planTextBlock: edits that make no sense', () => {
  const rejected = (id: string, lines: readonly string[]): unknown => {
    try {
      plan('x\n', lines, {}, id);
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it.each([
    ['an empty id', ''],
    ['an id with a space', 'a b'],
    ['an id with a newline', 'a\nb'],
    ['an id that starts with a dot', '.hidden'],
    ['an id that ends the marker early', 'x >>>'],
    ['an id that is far too long', 'x'.repeat(65)],
  ])('rejects %s', (_name, id) => {
    const error = rejected(id, LINES);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'invalid-edit' });
  });

  it.each([
    ['a line with a newline in it', ['a\nb']],
    ['a line with a carriage return in it', ['a\rb']],
    ['a line that is a begin marker', ['# >>> stroq harden: other >>>']],
    ['a line that is an end marker', [END]],
    ['a line that is not a string', [1 as unknown as string]],
  ])('rejects %s', (_name, lines) => {
    const error = rejected(ID, lines);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'invalid-edit' });
  });
});

describe('planTextBlock: the plan', () => {
  it('names the byte backup it will keep, or says there will be none', () => {
    expect(plan('node_modules/\n').backup).toBe('copy');
    const holding = plan('API_TOKEN=stroq_attack_fixture_value_0123456789\n');
    expect(holding.backup).toBe('none-credential-text');
    // The credential's line is context in the diff, so the diff hides it and says so.
    expect(holding.notices).toEqual([
      'no byte backup: the file holds credential-shaped text',
      'the diff hides lines that hold credential-shaped text',
    ]);
  });

  it('carries the recipe, the root and the mode for a new file that it was given', () => {
    const result = plan(null, LINES, { recipe: 'cursor-ignore', root: '/r', newFileMode: 0o644 });

    expect(result).toMatchObject({ recipe: 'cursor-ignore', root: '/r', newFileMode: 0o644 });
    expect(plan(null).recipe).toBe('custom');
  });

  it('writes nothing, and asks for the file by its real path', () => {
    const dir = tempDir();
    const file = join(dir, 'ignore');
    writeFileSync(file, 'a\n');
    const before = statSync(file);
    const asked: string[] = [];

    const result = planTextBlock(
      file,
      { id: ID, lines: LINES },
      {
        read: (path) => {
          asked.push(path);
          return readFileSync(path, 'utf8');
        },
      },
    );

    expect(asked).toEqual([file]);
    expect(result.real).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('a\n');
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(dir)).toEqual(['ignore']);
  });

  it.skipIf(process.platform === 'win32')('names the file a link leads to as the real path', () => {
    const dir = tempDir();
    const real = join(dir, 'dotfiles', 'cursorignore');
    const link = join(dir, 'project', '.cursorignore');
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(real, 'a\n');
    symlinkSync(real, link);

    const result = planTextBlock(link, { id: ID, lines: LINES }, { read: () => 'a\n' });

    expect(result.real).toBe(real);
    expect(result.file).toBe(link);
  });

  it('does not change the lines it was given, and does not share them', () => {
    const lines = Object.freeze(['a', 'b']);

    const result = plan('x\n', lines);

    expect(result.edits[0]?.lines).toEqual(['a', 'b']);
    expect(result.edits[0]?.lines).not.toBe(lines);
  });
});
