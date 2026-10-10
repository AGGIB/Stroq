import { describe, expect, it, vi } from 'vitest';
import { findCredentialShape } from '../../src/harden/credential-shape.js';
import { MAX_DIFF_LINES } from '../../src/harden/diff.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { planTextBlock } from '../../src/harden/textblock.js';
import type { JsonEdit } from '../../src/harden/types.js';
import { thrownBy } from './manifest-fixtures.js';

vi.mock('../../src/harden/credential-shape.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/harden/credential-shape.js')>();
  return { ...real, findCredentialShape: vi.fn(real.findCredentialShape) };
});

/**
 * A file too large to show a diff of is refused with a typed error. It is refused before it is
 * read for credentials: that reading is the most expensive thing a plan does, and a plan that
 * cannot be shown to the owner is not worth it.
 */
const FILE = '/project/settings.json';
const lines = (count: number): string =>
  `${Array.from({ length: count }, (_, i) => `# ${i}`).join('\n')}\n`;
const addDeny: JsonEdit = { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'x' };

describe('a plan of a file too large to show a diff of', () => {
  it('is refused by the text-block planner before the file is read for credentials', () => {
    const text = lines(MAX_DIFF_LINES + 1);
    vi.mocked(findCredentialShape).mockClear();

    const error = thrownBy(() =>
      planTextBlock(FILE, { id: 'cursor-ignore', lines: ['.env'] }, { read: () => text }),
    );

    expect(error).toMatchObject({ code: 'diff-too-large' });
    expect(findCredentialShape).not.toHaveBeenCalled();
  });

  it('is refused by the JSON planner before the file is read for credentials', () => {
    const text = `${JSON.stringify({ list: Array.from({ length: MAX_DIFF_LINES }, (_, i) => i) }, null, 2)}\n`;
    vi.mocked(findCredentialShape).mockClear();

    const error = thrownBy(() => planJsonEdits(FILE, [addDeny], { read: () => text }));

    expect(error).toMatchObject({ code: 'diff-too-large' });
    expect(findCredentialShape).not.toHaveBeenCalled();
  });

  it('still reads a file that can be shown', () => {
    vi.mocked(findCredentialShape).mockClear();

    const plan = planJsonEdits(FILE, [addDeny], { read: () => '{}\n' });

    expect(plan.backup).toBe('copy');
    expect(findCredentialShape).toHaveBeenCalled();
  });
});
