import { describe, expect, it } from 'vitest';
import { confirmTyped } from '../../src/ui/prompt.js';
import { fakeTerminal } from '../helpers/fake-terminal.js';

const digest = 'abcdef012345'.padEnd(64, '0');
describe('typed digest confirmation', () => {
  it('prints the full digest and accepts its first twelve hex digits, ignoring case', async () => {
    const f = fakeTerminal({ interactive: true, answers: [' ABCDEF012345 '] });
    expect(await confirmTyped(f.term, digest)).toBe(true);
    expect(f.out()).toContain(digest);
  });
  it.each([
    { answers: [] },
    { answers: [null] },
    { answers: ['y', 'yes', digest] },
    { answers: ['', 'wrong', 'abcdef01234'] },
  ])('refuses %j', async ({ answers }) => {
    const f = fakeTerminal({ interactive: true, answers });
    expect(await confirmTyped(f.term, digest)).toBe(false);
    expect(f.prompts.length).toBeLessThanOrEqual(3);
  });
  it('does not ask a pipe and rejects an invalid digest', async () => {
    const f = fakeTerminal({ interactive: true, answers: ['abcdef012345'] });
    expect(await confirmTyped({ ...f.term, interactive: false }, digest)).toBe(false);
    expect(f.prompts).toHaveLength(0);
    await expect(confirmTyped(f.term, 'not-a-digest')).rejects.toThrow(/digest/);
  });
});
