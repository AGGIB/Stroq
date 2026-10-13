// Colour, when it is wanted, and nothing when it is not: every function returns its argument as it
// came when colour is off, so the same line is the line in a log and the line on a screen.
import type { TerminalFacts } from './terminal.js';

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  /** The one colour of the product: orange where there are 256 colours, yellow where there are 8. */
  accent(text: string): string;
  good(text: string): string;
  bad(text: string): string;
  warn(text: string): string;
}

const wrap =
  (on: string, off: string) =>
  (text: string): string =>
    `\u001b[${on}m${text}\u001b[${off}m`;

const plain = (text: string): string => text;

export function styleFor(facts: Pick<TerminalFacts, 'color' | 'color256'>): Style {
  if (!facts.color)
    return { bold: plain, dim: plain, accent: plain, good: plain, bad: plain, warn: plain };
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    accent: facts.color256 ? wrap('38;5;208', '39') : wrap('33', '39'),
    good: wrap('32', '39'),
    bad: wrap('31', '39'),
    warn: wrap('33', '39'),
  };
}

/** The visible width of a line: what it is without the colour sequences. */
export const visibleLength = (text: string): number =>
  // eslint-disable-next-line no-control-regex
  [...text.replace(/\u001b\[[0-9;]*m/g, '')].length;
