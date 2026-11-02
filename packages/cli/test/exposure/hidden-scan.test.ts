import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HiddenScan, hiddenTextHit } from '../../src/exposure/agent-text.js';

/**
 * The check for characters nobody reading a file would see takes its text in pieces, so that a
 * file of any size can be scanned without being held in memory. A piece may end anywhere that is
 * not inside a code point, and the answer must be the one the whole text gives: the same counts,
 * the same digest of the characters in order, the same line. Here the whole-text answer is worked
 * out again by a copy of the check as it was before it could take pieces, and every way of cutting
 * a set of texts into pieces is held to it.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/gu;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const STYLE = new Set([0xfe0e, 0xfe0f]);
const matches = (re: RegExp, code: number | undefined): boolean =>
  code !== undefined && re.test(String.fromCodePoint(code));
function before(text: string, at: number): { code: number | undefined; at: number } {
  if (at <= 0) return { code: undefined, at: 0 };
  const start = at >= 2 && (text.codePointAt(at - 2) ?? 0) > 0xffff ? at - 2 : at - 1;
  return { code: text.codePointAt(start), at: start };
}
function stylesEmoji(text: string, at: number): boolean {
  const prev = before(text, at).code;
  if (matches(PICTOGRAPH, prev)) return true;
  return matches(KEYCAP_BASE, prev) && text.codePointAt(at + 1) === 0x20e3;
}
function joinedFrom(text: string, at: number): number {
  const prev = before(text, at);
  const base =
    prev.code !== undefined && (STYLE.has(prev.code) || matches(SKIN_TONE, prev.code))
      ? before(text, prev.at)
      : prev;
  return matches(PICTOGRAPH, base.code) && matches(PICTOGRAPH, text.codePointAt(at + 1))
    ? base.at
    : -1;
}
const name = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/** The answer for a whole text, as the check gave it before it could take pieces. */
function oracle(text: string): { value: string; line: number } | undefined {
  const counts = new Map<number, number>();
  const order: string[] = [];
  let first = -1;
  let next = -1;
  let joins = 0;
  for (const match of text.matchAll(HIDDEN)) {
    const at = match.index;
    const code = match[0].codePointAt(0) ?? 0;
    if (at === 0 && code === 0xfeff) continue;
    if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) continue;
    if (STYLE.has(code) && stylesEmoji(text, at)) continue;
    if (code === 0x200d) {
      const from = joinedFrom(text, at);
      if (from !== -1) {
        joins = from === next ? joins + 1 : 1;
        next = at + 1;
        if (joins <= 3) continue;
      }
    }
    counts.set(code, (counts.get(code) ?? 0) + 1);
    order.push(match[0]);
    if (first === -1) first = at;
  }
  if (counts.size === 0) return undefined;
  const digest = createHash('sha256').update(order.join('')).digest('hex').slice(0, 16);
  const value = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([code, count]) => `${name(code)} x${count}`)
    .join(', ');
  return {
    value: `${value} (sha256:${digest})`,
    line: 1 + (text.slice(0, first).match(/\n/g)?.length ?? 0),
  };
}

const answer = (hit: { value: string; line: number } | undefined) =>
  hit === undefined ? undefined : { value: hit.value, line: hit.line };

/** The answer for a text given in the pieces cut at `cuts` (offsets, none inside a code point). */
function inPieces(text: string, cuts: readonly number[]) {
  const scan = new HiddenScan();
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    scan.feed(text.slice(from, cut));
    from = cut;
  }
  return answer(scan.finish('f.md'));
}

/** Offsets of a text where a piece may end: before every code point. */
const boundaries = (text: string): number[] => {
  const out: number[] = [];
  let at = 0;
  for (const ch of text) {
    out.push(at);
    at += ch.length;
  }
  return out.filter((n) => n > 0);
};

const ATOMS = [
  'a',
  'b ',
  '\n',
  '\r\n',
  '\r',
  '\t',
  '\u0001',
  '\u007f',
  '\u0085',
  '​',
  '‌',
  '‍',
  '⁠',
  '﻿',
  '︎',
  '️',
  '‮',
  '­',
  '😀',
  '👨',
  '👩',
  '👧',
  '👦',
  '🏽',
  '❤',
  '1',
  '#',
  '⃣',
  '\u{e0041}',
  '\u{e0042}',
  '\u{e0001}',
  'é',
  '字',
];

/** A small generator with a seed, so a failure can be run again. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const textOf = (random: () => number, atoms: number): string =>
  Array.from({ length: atoms }, () => ATOMS[Math.floor(random() * ATOMS.length)]).join('');

describe('the scan for hidden characters, in pieces', () => {
  it('gives the answer of the whole text for the whole text', () => {
    const random = rng(1);
    for (let i = 0; i < 300; i += 1) {
      const text = textOf(random, 1 + Math.floor(random() * 60));
      expect(answer(hiddenTextHit('f.md', text)), JSON.stringify(text)).toEqual(oracle(text));
    }
  });

  it('gives the same answer however the text is cut: every single cut, and two', () => {
    const random = rng(2);
    for (let i = 0; i < 120; i += 1) {
      const text = textOf(random, 1 + Math.floor(random() * 40));
      const want = oracle(text);
      const cuts = boundaries(text);
      for (const cut of cuts)
        expect(inPieces(text, [cut]), `${JSON.stringify(text)} @${cut}`).toEqual(want);
      for (let j = 0; j < 20 && cuts.length > 1; j += 1) {
        const a = cuts[Math.floor(random() * cuts.length)] as number;
        const b = cuts[Math.floor(random() * cuts.length)] as number;
        const two = [a, b].sort((x, y) => x - y);
        expect(inPieces(text, two), `${JSON.stringify(text)} @${two}`).toEqual(want);
      }
    }
  });

  it('gives the same answer for a text cut into pieces of one code point', () => {
    const random = rng(3);
    for (let i = 0; i < 200; i += 1) {
      const text = textOf(random, 1 + Math.floor(random() * 80));
      expect(inPieces(text, boundaries(text)), JSON.stringify(text)).toEqual(oracle(text));
    }
  });

  it('gives the same answer for long texts cut into pieces of random sizes', () => {
    const random = rng(4);
    for (let i = 0; i < 20; i += 1) {
      const text = textOf(random, 3000 + Math.floor(random() * 3000));
      const cuts = boundaries(text).filter(() => random() < 0.02);
      expect(inPieces(text, cuts)).toEqual(oracle(text));
    }
  });

  it('keeps the emoji sequences that hide nothing, across a cut', () => {
    const family = '👨‍👩‍👧‍👦';
    const longer = `${family}‍👦‍👧`;
    for (const text of [
      `a ${family} b`,
      `a ${longer} b`,
      '❤️',
      '1️⃣',
      '👍🏽‍👨',
      '﻿abc',
      'abc﻿',
      'a\r\nb\r\n',
      'a\rb',
      '‍',
      '👨‍',
      '‍👩',
    ]) {
      const want = oracle(text);
      for (const cut of boundaries(text))
        expect(inPieces(text, [cut]), `${JSON.stringify(text)} @${cut}`).toEqual(want);
    }
    expect(oracle(`a ${family} b`)).toBeUndefined();
    expect(oracle(`a ${longer} b`)).toBeDefined();
  });

  it('puts the first hidden character on its line, however far in', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join('');
    const text = `${lines}x​y`;
    expect(answer(hiddenTextHit('f.md', text))?.line).toBe(5001);
    const cuts = boundaries(text).filter((n) => n % 997 === 0);
    expect(inPieces(text, cuts)).toEqual(oracle(text));
  });

  it('says whether it has found any, before it is finished', () => {
    const scan = new HiddenScan();
    scan.feed('a'.repeat(100));
    expect(scan.found).toBe(false);
    scan.feed(`${'b'.repeat(100)}​${'c'.repeat(100)}`);
    expect(scan.found).toBe(true);
    expect(scan.finish('f.md')?.value).toMatch(/^U\+200B x1 \(sha256:[0-9a-f]{16}\)$/);
  });

  it('counts no more than the limit it is given, the first ones, however the text is cut', () => {
    const text = 'a\u200bb\u2060c\u202e'.repeat(20);
    // The answer for the text up to and including its seventh hidden character.
    let end = 0;
    for (let seen = 0, at = 0; seen < 7; at += 1) {
      if (/[\u200b\u2060\u202e]/.test(text[at] as string)) seen += 1;
      end = at + 1;
    }
    const want = oracle(text.slice(0, end));
    for (const cuts of [[], [3], [1, 2, 3, 4, 5, 6, 7, 8, 9], boundaries(text)]) {
      const scan = new HiddenScan(7);
      let from = 0;
      for (const cut of [...cuts, text.length]) {
        scan.feed(text.slice(from, cut));
        from = cut;
      }
      expect(scan.full).toBe(true);
      expect(answer(scan.finish('f.md')), JSON.stringify(cuts)).toEqual(want);
    }
  });

  it('holds only a few characters of a long text at a time', () => {
    const scan = new HiddenScan();
    for (let i = 0; i < 200; i += 1) scan.feed('x'.repeat(100_000));
    expect(scan.kept).toBeLessThan(100);
    expect(scan.finish('f.md')).toBeUndefined();
  });
});
