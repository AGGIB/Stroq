// The glyphs a screen uses, and what stands for each where a terminal cannot draw them.
export interface Symbols {
  readonly ok: string;
  readonly bad: string;
  readonly none: string;
  readonly dot: string;
  readonly arrow: string;
  readonly ask: string;
  /** What stands for the part of a path that was cut out. */
  readonly ellipsis: string;
  readonly frames: readonly string[];
}

const DRAWN: Symbols = {
  ok: '✔',
  bad: '✘',
  none: '–',
  dot: '·',
  arrow: '→',
  ask: '?',
  ellipsis: '…',
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const PLAIN: Symbols = {
  ok: '+',
  bad: 'x',
  none: '-',
  dot: '*',
  arrow: '->',
  ask: '?',
  ellipsis: '...',
  frames: ['|', '/', '-', '\\'],
};

export const symbolsFor = (unicode: boolean): Symbols => (unicode ? DRAWN : PLAIN);
