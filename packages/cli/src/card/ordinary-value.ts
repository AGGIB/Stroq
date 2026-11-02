// Which key values may stay in part of a name the card prints, and which hide the whole of it.
//
// A key's value is never printed. Everywhere it is found it is cut out (`scrub.ts`), whatever it is. A
// name that came from a session (a folder, a transcript path, a host) is held to a coarser rule on top
// of that: if it holds six characters of any key, in any case, the whole name is hidden
// (`[a name that holds a key]`, `pieces.ts`). That is right for a token. It is wrong for a value that is
// one ordinary word: a `.env` that says `DB_PASSWORD=administrator` would blank
// `/work/administrator-site` and every transcript path under it. So for such a value the coarse rule is
// replaced by a finer one: the value itself is cut out of the name (`/work/[key]-site`), and a piece of
// it is no reason to hide anything. The value is still looked for in every session and still counted.
//
// An ordinary value is exactly one word of a short fixed list (the common words of `english-words.ts`
// and the user, host and environment names that turn up as credentials: `admin`, `root`, `postgres`,
// `production`, `localhost`), in one case (`production`, `Production`, `PRODUCTION`), and no longer than
// `MAX_ORDINARY_CHARS`. Nothing else is, however short or however much it looks like a name: a value
// of several words (a passphrase), one with digits or signs, a slug, a word that is not on the list.
// Those keep guarding names by their pieces.
import type { Key } from '../sent/keys.js';
import { COMMON_WORDS } from './english-words.js';

/** The longest ordinary value. */
export const MAX_ORDINARY_CHARS = 14;

/** The user, host, database and environment names that are used as credentials. */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set(
  `
admin administrator root guest demo tester dev devel development prod production preprod stage
staging qa uat sandbox preview local localhost default postgres postgresql mysql mariadb mongo
mongodb redis memcached rabbitmq kafka elastic elasticsearch docker kubernetes nginx apache ubuntu
debian changeme password passwd secret
`
    .split(/\s+/)
    .filter((w) => w !== ''),
);

/** One word in one case: `admin`, `Admin`, `ADMIN`. */
const ONE_WORD = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/;

/** Whether a value is one ordinary word: one the whole name it is found in is not hidden for. */
export function isOrdinaryValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ORDINARY_CHARS || !ONE_WORD.test(value))
    return false;
  const word = value.toLowerCase();
  return CREDENTIAL_WORDS.has(word) || COMMON_WORDS.has(word);
}

/** Whether a key's value hides the whole name it is found a piece of: every key but an ordinary one. */
export const namesGuard = (key: Pick<Key, 'value'>): boolean => !isOrdinaryValue(key.value);
