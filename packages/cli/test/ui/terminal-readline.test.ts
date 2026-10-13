import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSafeOutput } from '../../src/terminal-safe.js';
import { TYPEAHEAD_MS, currentTerminal } from '../../src/ui/terminal.js';

const ESC = '\u001b';

/**
 * `stroq init` runs inside `withSafeOutput`, which writes every control character that reaches
 * `process.stdout` out as visible text. The question the first-run screen asks goes to a terminal
 * through `readLine`, which opens a readline interface on `process.stdout`: its prompt, its
 * colours and the cursor movement and the newline it writes itself must all arrive as what they
 * are, not as `\u001b[1G` on the person's screen.
 */
describe('currentTerminal().readLine inside withSafeOutput', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Asks `prompt` of a person who types `typed`, and returns the answer and what the screen saw. */
  async function ask(
    prompt: string,
    typed: string,
    after = 0,
  ): Promise<{ answer: string | null; seen: string }> {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    const seen: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      seen.push(String(chunk));
      return true;
    });
    const term = currentTerminal();

    const answer = await withSafeOutput(async () => {
      const pending = term.readLine(prompt);
      // How long after the question the person types.
      if (after > 0) await new Promise((resolve) => setTimeout(resolve, after));
      input.write(typed);
      return pending;
    });

    return { answer, seen: seen.join('') };
  }

  it('returns what the person typed', async () => {
    const { answer } = await ask('  Guard it? (Y/n) ', 'y\r');

    expect(answer).toBe('y');
  });

  it('returns an empty answer for an Enter that was typed after the question was seen', async () => {
    const { answer } = await ask('  Guard it? (Y/n) ', '\r', TYPEAHEAD_MS + 50);

    expect(answer).toBe('');
  });

  // A key held down while the package was fetched is waiting when the question is asked: it is not an
  // answer, and the default answer is a yes.
  it('does not take an Enter typed ahead of the question for an answer', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const term = currentTerminal();
    let settled = false;

    const pending = term.readLine('  Guard it? (Y/n) ').then((line) => {
      settled = true;
      return line;
    });
    input.write('\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    input.write('y\n');

    expect(await pending).toBe('y');
  });

  it('takes an explicit answer typed ahead of the question: that is what a script does', async () => {
    const { answer } = await ask('  Guard it? (Y/n) ', 'n\n');

    expect(answer).toBe('n');
  });

  it('is not held by a bare Enter typed ahead when the input then ends', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const term = currentTerminal();

    const pending = term.readLine('  Guard it? (Y/n) ');
    input.write('\n');
    input.end();

    expect(await pending).toBeNull();
  });

  it('returns null when the input ends before there is an answer', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const term = currentTerminal();

    const pending = term.readLine('  Guard it? (Y/n) ');
    input.end();

    expect(await pending).toBeNull();
  });

  // `readLine` opens its readline interface on `process.stdout`, which `withSafeOutput` has wrapped,
  // so everything readline writes (its prompt, `ESC[1G`, the newline after Enter) is neutralized and
  // shows on the screen as text. Seen with the built CLI on a pty: `\u001b[1G\u001b[0J ... \u000d`.
  it('shows no cursor movement or newline of readline as text', async () => {
    const { seen } = await ask('  Guard it? (Y/n) ', 'y\r');

    expect(seen).not.toContain('\\u001b');
    expect(seen).not.toContain('\\u000d');
  });

  it('shows the colours of the prompt as colours, not as text', async () => {
    const prompt = `  ${ESC}[38;5;208m?${ESC}[39m Guard it? ${ESC}[2m(Y/n)${ESC}[22m `;

    const { seen } = await ask(prompt, 'y\r');

    expect(seen).not.toContain('\\u001b');
    expect(seen).not.toContain('[38;5;208m?\\u');
  });
});
