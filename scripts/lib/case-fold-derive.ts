/**
 * What the regex engine itself says about which characters are the same under the `i` flag.
 *
 * The literal prefilter (packages/core/src/rules/prefilter) looks for a rule's literals in a text
 * after case folding both, and it is only sound if its folding never separates two characters the
 * engine treats as equal. So the folding is not taken from a table of Unicode rules: it is derived
 * from the engine, by asking it, and checked against the engine again by
 * packages/core/test/rules/prefilter/case-fold.test.ts on every run.
 *
 * Two modes differ: without `u` the engine compares UTF-16 code units through `toUpperCase` and
 * leaves a non-ASCII unit that would become ASCII alone (so U+017F stays apart from `s`); with `u` it
 * uses simple case folding over code points (so U+017F is `s`, and U+212A the Kelvin sign is `k`).
 */

export type FoldFlags = 'i' | 'iu';

const MAX_UNIT = 0xffff;
const MAX_POINT = 0x10ffff;
const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;

/**
 * Every character that has a case mapping, and every character those mappings produce: the only
 * characters that can be equal to another under `i`. A character that is neither is its own class.
 */
export function casedCharacters(flags: FoldFlags): readonly number[] {
  const max = flags === 'iu' ? MAX_POINT : MAX_UNIT;
  const found = new Set<number>();
  for (let code = 0; code <= max; code += 1) {
    if (isSurrogate(code)) continue;
    const char = String.fromCodePoint(code);
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower === char && upper === char) continue;
    found.add(code);
    for (const mapped of [lower, upper])
      for (const piece of mapped) {
        const point = piece.codePointAt(0) ?? 0;
        if (point <= max && !isSurrogate(point)) found.add(point);
      }
  }
  return [...found].sort((a, b) => a - b);
}

/** A regex that matches exactly the characters the engine takes to be `code` (and only it, ^$). */
export function sameAs(code: number, flags: FoldFlags): RegExp {
  const hex = code.toString(16);
  const source = flags === 'iu' ? `^\\u{${hex}}$` : `^\\u${hex.padStart(4, '0')}$`;
  return new RegExp(source, flags);
}

/** The engine's equivalence classes among the cased characters, those of two or more. */
export function engineClasses(flags: FoldFlags): readonly (readonly number[])[] {
  const cased = casedCharacters(flags);
  const chars = cased.map((code) => String.fromCodePoint(code));
  const placed = new Set<number>();
  const classes: number[][] = [];
  cased.forEach((code, index) => {
    if (placed.has(code)) return;
    const test = sameAs(code, flags);
    const members = cased.filter((_, other) => test.test(chars[other] ?? ''));
    for (const member of members) placed.add(member);
    // A class always holds the character it was built from.
    if (members.length > 1 && members.includes(cased[index] ?? -1)) classes.push(members);
  });
  return classes;
}

/**
 * The characters, after `toLowerCase`, that must be treated as one: what is left to fold once the
 * text is lower-cased. For each class, the lower-cased forms of its members are one group, groups
 * that share a form are merged, and each group is listed ascending, so its first member is the one
 * the others turn into. A group of one needs nothing and is not listed.
 *
 * Throws if a member of a class lower-cases to anything but one character, which would make a
 * per-character fold of the text impossible.
 */
export function collapseGroups(
  classes: readonly (readonly number[])[],
): readonly (readonly number[])[] {
  const parent = new Map<number, number>();
  const find = (code: number): number => {
    const up = parent.get(code);
    if (up === undefined || up === code) return code;
    const root = find(up);
    parent.set(code, root);
    return root;
  };
  const join = (a: number, b: number): void => {
    const [low, high] = [find(a), find(b)].sort((x, y) => x - y) as [number, number];
    parent.set(high, low);
    if (!parent.has(low)) parent.set(low, low);
  };
  for (const members of classes) {
    const lowered = members.map((code) => {
      const pieces = [...String.fromCodePoint(code).toLowerCase()];
      if (pieces.length !== 1)
        throw new Error(`U+${code.toString(16)} lower-cases to ${pieces.length} characters`);
      return pieces[0]?.codePointAt(0) ?? 0;
    });
    for (const code of lowered) if (!parent.has(code)) parent.set(code, code);
    for (const code of lowered.slice(1)) join(lowered[0] ?? 0, code);
  }
  const groups = new Map<number, number[]>();
  for (const code of parent.keys())
    groups.set(find(code), [...(groups.get(find(code)) ?? []), code]);
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}
