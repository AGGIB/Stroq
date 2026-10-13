// A yes-or-no question, asked only where a person can answer it.
import { wrap } from './layout.js';
import { visibleLength, type Style } from './style.js';
import type { Terminal } from './terminal.js';

const YES = /^(?:y|yes)$/i;
const NO = /^(?:n|no)$/i;
const ATTEMPTS = 3;

/** A digest is accepted only from a person at a terminal; EOF and three misses are a refusal. */
export async function confirmTyped(term: Terminal, digest: string): Promise<boolean> {
  if (!term.interactive) return false;
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid confirmation digest');
  term.write(`  sha256:${digest}\n`);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const line = await term.readLine('  Type the first 12 hex characters to confirm: ');
    if (line === null) return false;
    if (line.trim().toLowerCase() === digest.slice(0, 12)) return true;
    term.write('  The digest did not match.\n');
  }
  return false;
}

/**
 * Asks `question` and returns the answer. Enter takes the default. An answer that is neither yes nor
 * no is asked again, twice, and then is a no; so is the end of the input. Nothing is changed on a
 * guess: a question about changing someone's configuration that is answered by a closed pipe is
 * not a yes.
 */
export async function confirm(
  term: Terminal,
  style: Style,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  let prompt = `  ${style.accent('?')} ${question} ${style.dim(`(${hint})`)} `;
  // A question that would wrap on this terminal is put on lines of its own, and the answer is typed
  // after the hint on the last one.
  if (visibleLength(prompt) >= term.columns) {
    wrap(question, term.columns - 4).forEach((line, i) =>
      term.write(`  ${i === 0 ? style.accent('?') : ' '} ${line}\n`),
    );
    prompt = `    ${style.dim(`(${hint})`)} `;
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const line = await term.readLine(prompt);
    if (line === null) return false;
    const answer = line.trim();
    if (answer === '') return defaultYes;
    if (YES.test(answer)) return true;
    if (NO.test(answer)) return false;
    term.write(`  ${style.dim('Please answer y or n.')}\n`);
  }
  return false;
}
