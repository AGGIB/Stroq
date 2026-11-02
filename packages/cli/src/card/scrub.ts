// Taking a key out of what the card keeps.
//
// A command or an excerpt reaches the card already redacted by the audit (patterns, long opaque tokens),
// and the replay's throwaway engine knows none of this machine's keys. So before a summary is written
// to the cache, the main thread, which has read the key files for the key check, takes out of every
// string any value it holds (in any of the spellings the key check looks for), and whatever has the
// shape of a provider's token. What is kept never holds a key's value.
import type { KeyFinder } from '../sent/keys.js';
import { redactTokens } from '../sent/token-shapes.js';
import type { SessionSummary, ToldMoment } from './schema.js';

export type Scrub = (text: string) => string;

const MARK = '[key]';

/**
 * A function that takes out of a text every key `finder` holds, in every spelling it has there, and
 * the shapes of tokens. Every key: a value that is an ordinary word is taken out too, wherever it
 * stands (`ordinary-value.ts` only changes how a whole name that holds a piece of a key is hidden).
 */
export function scrubber(finder: KeyFinder): Scrub {
  return (text) => {
    let out = text;
    if (finder.keys.length > 0) {
      // The longest spelling first: a value that begins another (`admin`, `administrator`) must not
      // be cut out of it and leave the rest.
      const forms = [...new Set(finder.find(out).flatMap((found) => found.forms))].sort(
        (a, b) => b.length - a.length,
      );
      for (const form of forms) out = out.split(form).join(MARK);
    }
    return redactTokens(out, MARK);
  };
}

function scrubMoment(moment: ToldMoment, scrub: Scrub): ToldMoment {
  return {
    ...moment,
    ...(moment.pkg === undefined ? {} : { pkg: scrub(moment.pkg) }),
    command: scrub(moment.command),
    read: {
      ...moment.read,
      source: scrub(moment.read.source),
      excerpt: scrub(moment.read.excerpt),
    },
  };
}

/** A summary with every string that came from a transcript scrubbed: its ids and folder too. */
export function scrubSummary(summary: SessionSummary, scrub: Scrub): SessionSummary {
  return {
    ...summary,
    sessionId: scrub(summary.sessionId),
    cwd: summary.cwd === null ? null : scrub(summary.cwd),
    moments: summary.moments.map((m) => scrubMoment(m, scrub)),
  };
}
