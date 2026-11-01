import { foldText, type FoldMode } from './case-fold.js';

/**
 * What is known about one text while a scan runs: its folded forms, and which literals it holds.
 *
 * A scan asks the same text the same question many times over: a few hundred rules share a few
 * hundred literals, and each rule asks. A literal is looked for in a text once; the answer is kept.
 * The folded text is made once per fold, and only if some rule needs that fold.
 */
export class TextIndex {
  private readonly folded = new Map<FoldMode, string>();
  private readonly answers: Readonly<Record<FoldMode, Map<string, boolean>>> = {
    none: new Map(),
    i: new Map(),
    iu: new Map(),
  };

  constructor(readonly text: string) {}

  /** Whether the text, folded as `mode` says, holds `literal` (which is folded the same way). */
  holds(mode: FoldMode, literal: string): boolean {
    const answers = this.answers[mode];
    const known = answers.get(literal);
    if (known !== undefined) return known;
    const found = this.foldedText(mode).includes(literal);
    answers.set(literal, found);
    return found;
  }

  private foldedText(mode: FoldMode): string {
    const known = this.folded.get(mode);
    if (known !== undefined) return known;
    const made = foldText(mode, this.text);
    this.folded.set(mode, made);
    return made;
  }
}

/** The most texts a scan reads at once: the content, a tool's response and its description. */
const KEPT = 4;

/**
 * The `TextIndex` of each text a scan is reading, found by the text itself. A scan names the same
 * few strings again and again, so a handful are kept and the oldest is let go.
 */
export class TextIndexes {
  private readonly kept: TextIndex[] = [];

  of(text: string): TextIndex {
    for (const index of this.kept) if (index.text === text) return index;
    const made = new TextIndex(text);
    this.kept.push(made);
    if (this.kept.length > KEPT) this.kept.shift();
    return made;
  }
}
