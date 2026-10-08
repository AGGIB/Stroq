import { describe, expect, it } from 'vitest';
import { confirm } from '../../src/ui/prompt.js';
import { styleFor } from '../../src/ui/style.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';

const QUESTION = 'Guard Claude Code in this project?';
const PLEASE_ANSWER = 'Please answer y or n.';
const PLAIN = styleFor({ color: false, color256: false });
const SGR = new RegExp('\\u001b\\[[0-9;]*m', 'g');

/** Asks QUESTION of a person who types `answers`, and says what came of it. */
async function ask(
  answers: readonly (string | null)[],
  defaultYes?: boolean,
): Promise<{ result: boolean; fake: ReturnType<typeof fakeTerminal> }> {
  const fake = fakeTerminal({ answers });
  const result =
    defaultYes === undefined
      ? await confirm(fake.term, PLAIN, QUESTION)
      : await confirm(fake.term, PLAIN, QUESTION, defaultYes);
  return { result, fake };
}

describe('confirm', () => {
  describe('Enter', () => {
    it('takes the default when it is yes', async () => {
      const { result } = await ask([''], true);

      expect(result).toBe(true);
    });

    it('takes the default when it is no', async () => {
      const { result } = await ask([''], false);

      expect(result).toBe(false);
    });

    it('takes yes when no default is given', async () => {
      const { result } = await ask(['']);

      expect(result).toBe(true);
    });

    it('takes the default for an answer that is only spaces', async () => {
      expect((await ask(['   '], true)).result).toBe(true);
      expect((await ask(['   '], false)).result).toBe(false);
    });
  });

  describe('yes', () => {
    it.each(['y', 'yes', 'Y', 'YES', 'Yes', 'yEs', ' y ', '\tyes\t'])('is %j', async (answer) => {
      expect((await ask([answer], false)).result).toBe(true);
    });
  });

  describe('no', () => {
    it.each(['n', 'no', 'N', 'NO', 'No', ' n ', '\tno\t'])('is %j', async (answer) => {
      expect((await ask([answer], true)).result).toBe(false);
    });
  });

  describe('an answer that is neither', () => {
    it('is asked again, with a word on what to type', async () => {
      const { result, fake } = await ask(['maybe', 'y'], false);

      expect(result).toBe(true);
      expect(fake.prompts).toHaveLength(2);
      expect(fake.out()).toBe(`  ${PLEASE_ANSWER}\n`);
    });

    it.each(['yep', 'yeah', 'ye', 'nope', 'y y', 'yes please', 'ok', '1', 'true'])(
      'is not taken for yes or no when it is %j',
      async (answer) => {
        const { fake } = await ask([answer, 'n'], true);

        expect(fake.prompts).toHaveLength(2);
        expect(fake.out()).toContain(PLEASE_ANSWER);
      },
    );

    it('is a no after three of them, and nothing is asked a fourth time', async () => {
      const { result, fake } = await ask(['a', 'b', 'c', 'y'], true);

      expect(result).toBe(false);
      expect(fake.prompts).toHaveLength(3);
      expect(fake.out().split(PLEASE_ANSWER)).toHaveLength(4);
    });

    it('never takes the default, even when it is yes', async () => {
      const { result } = await ask(['what', 'what', 'what'], true);

      expect(result).toBe(false);
    });

    it('is forgiven when the third try is an answer', async () => {
      const { result, fake } = await ask(['a', 'b', 'yes'], false);

      expect(result).toBe(true);
      expect(fake.prompts).toHaveLength(3);
    });

    it('takes the default for an Enter that comes after an answer that was neither', async () => {
      const { result } = await ask(['nope', ''], true);

      expect(result).toBe(true);
    });
  });

  describe('the end of the input', () => {
    it('is a no, even when the default is yes', async () => {
      const { result, fake } = await ask([null], true);

      expect(result).toBe(false);
      expect(fake.prompts).toHaveLength(1);
    });

    it('is a no when nothing was typed at all and the input has run out', async () => {
      const { result } = await ask([], true);

      expect(result).toBe(false);
    });

    it('is a no after an answer that was neither', async () => {
      const { result, fake } = await ask(['hmm', null], true);

      expect(result).toBe(false);
      expect(fake.prompts).toHaveLength(2);
    });
  });

  describe('the prompt', () => {
    it('holds the question and the Y/n hint when the default is yes', async () => {
      const { fake } = await ask(['y'], true);

      expect(fake.prompts).toHaveLength(1);
      expect(fake.prompts[0]).toContain(QUESTION);
      expect(fake.prompts[0]).toContain('(Y/n)');
    });

    it('holds the question and the y/N hint when the default is no', async () => {
      const { fake } = await ask(['y'], false);

      expect(fake.prompts[0]).toContain(QUESTION);
      expect(fake.prompts[0]).toContain('(y/N)');
      expect(fake.prompts[0]).not.toContain('(Y/n)');
    });

    it('is indented, marked with a question mark, and ends with a space for the answer', async () => {
      const { fake } = await ask(['y']);

      expect(fake.prompts[0]).toBe(`  ? ${QUESTION} (Y/n) `);
    });

    it('is the same prompt each time it asks again', async () => {
      const { fake } = await ask(['x', 'y']);

      expect(fake.prompts[0]).toBe(fake.prompts[1]);
    });

    it('colours the mark and dims the hint, and shows the same words', async () => {
      const fake = fakeTerminal({ answers: ['y'] });
      const style = styleFor({ color: true, color256: true });

      await confirm(fake.term, style, QUESTION, true);

      const prompt = fake.prompts[0] ?? '';
      expect(prompt).toContain(style.accent('?'));
      expect(prompt).toContain(style.dim('(Y/n)'));
      expect(prompt.replace(SGR, '')).toBe(`  ? ${QUESTION} (Y/n) `);
    });
  });

  it('asks only as many answers as it needs, and leaves the rest', async () => {
    const { fake } = await ask(['y', 'n']);

    expect(fake.answers).toEqual(['n']);
  });

  it('writes nothing of its own when the answer is clear', async () => {
    const { fake } = await ask(['y']);

    expect(fake.writes).toEqual([]);
  });
});
