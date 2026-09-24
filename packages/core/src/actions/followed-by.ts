/**
 * Anything with a `test`, so a table of detectors can hold a `RegExp` and one of the
 * tests below side by side.
 */
export interface TextTest {
  test(text: string): boolean;
}

/** A `TextTest` that stands for one regular expression, and says which. */
export interface PatternTest extends TextTest {
  /** The pattern this answers for, as its `source` would read. */
  readonly source: string;
}

/** What the gap between `head` and `tail` may not contain. */
export type Gap = 'line' | 'word';

const GAP: Readonly<Record<Gap, { readonly stop: string; readonly source: string }>> = {
  line: { stop: '\\n', source: '[^\\n]*' },
  word: { stop: '\\s', source: '[^\\s]*' },
};

const global = (re: RegExp): RegExp =>
  new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

/**
 * `head`, then `tail` further along the same line (or the same word) — what the
 * pattern `head[^\n]*tail` asks — answered in time linear in the text.
 *
 * The pattern form is not. From every place `head` matches it runs `[^\n]*` to the
 * end of the line and backs off one character at a time looking for `tail`, so a line
 * of many heads and no tail costs the square of its length: 16 KiB of `eval ` took
 * 28 s to classify. A command is written by the agent, the classifier runs inside
 * the agent's hook, and a hook that runs past its timeout is answered by the agent
 * instead — which for Codex and Copilot is an allow.
 *
 * Here each head asks two questions whose answers only move forward: where the first
 * `tail` at or after its end is, and where the first character the gap may not cross
 * is. Both are kept until a head ends beyond them, so no stretch of the text is
 * searched twice. The match exists exactly when that tail starts no later than that
 * character, which is where `[^\n]*` has to stop and where a tail beginning with
 * `\s` may still begin.
 *
 * `head` must match at most one way from a given start, as a word or a fixed phrase
 * does: this looks only at the end `exec` reports. Every use has a test that compares
 * it with the pattern it replaced.
 */
export function followedBy(head: RegExp, tail: RegExp, gap: Gap = 'line'): PatternTest {
  const heads = global(head);
  const tails = global(tail);
  const stops = new RegExp(GAP[gap].stop, 'g');
  return {
    source: `${head.source}${GAP[gap].source}${tail.source}`,
    test(text: string): boolean {
      // Positions of the first tail and the first stop at or after `…From`.
      let tailFrom = Infinity;
      let tailAt = -1;
      let stopFrom = Infinity;
      let stopAt = -1;
      heads.lastIndex = 0;
      for (let h = heads.exec(text); h !== null; h = heads.exec(text)) {
        const from = h.index + h[0].length;
        if (from < tailFrom || (tailAt !== -1 && tailAt < from)) {
          tails.lastIndex = from;
          tailFrom = from;
          tailAt = tails.exec(text)?.index ?? -1;
        }
        // No tail after this head means none after any head that ends later.
        if (tailAt === -1 && from >= tailFrom) return false;
        if (from < stopFrom || (stopAt !== -1 && stopAt < from)) {
          stops.lastIndex = from;
          stopFrom = from;
          stopAt = stops.exec(text)?.index ?? -1;
        }
        if (stopAt === -1 || tailAt <= stopAt) return true;
        // The next head may start inside this one, so the search resumes one past its
        // start rather than past its end.
        heads.lastIndex = h.index + 1;
      }
      return false;
    },
  };
}

/** True when any of `tests` is: an alternation `a|b` split into its branches. */
export function anyOf(...tests: readonly TextTest[]): TextTest {
  return { test: (text) => tests.some((t) => t.test(text)) };
}
