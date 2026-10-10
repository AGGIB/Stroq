// Telling, from the words a host used, that it stopped because of the account and not because of
// anything the check did. Both patterns run over text a host or a command printed, so both are
// alternations of plain words with no repetition inside them: the time they take grows with the length
// of the text and nothing else (`limit-text.test.ts` runs them over a megabyte built to be slow).

/**
 * The messages hosts give when a plan's usage, a rate or the account's credit has run out: the older
 * "usage limit reached" and "reached your", and the banners of a plan that has run out now ("you've hit
 * your limit", "weekly limit", "5-hour limit", "limit reached", and "resets at" or "resets in" a time).
 * Every alternative is a plain phrase; the one that starts with `\b` is a boundary and not a repeat, so
 * that "presets in" is not "resets in".
 */
const LIMIT =
  /usage limit|reached your|hit your limit|weekly limit|5-hour limit|limit reached|\bresets? (?:at|in)\b|credit balance|rate.?limit|overloaded|waiting for usage/i;

/** The messages hosts give when nobody is logged in, or the login no longer works. */
const AUTH =
  /invalid api key|please run \/login|not logged in|authentication[_ ]error|token has expired|unauthorized/i;

/** A reason is a few words: what matched, and not the text around it. */
const MAX_REASON_CHARS = 40;

function firstMatch(pattern: RegExp, text: string): string | null {
  const found = pattern.exec(text);
  return found === null ? null : found[0].toLowerCase().slice(0, MAX_REASON_CHARS);
}

/** Why the host stopped, when its words say it ran into a limit; null for any other text. */
export const limitTextOf = (text: string): string | null => firstMatch(LIMIT, text);

/** Why the host could not start, when its words say nobody is logged in; null for any other text. */
export const authTextOf = (text: string): string | null => firstMatch(AUTH, text);
