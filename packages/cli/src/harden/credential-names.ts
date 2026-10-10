import { extractEnv, isSecretValue } from '@stroq/core';
import { looksLikeVendorToken } from './credential-vendors.js';
import { hasSpace, isLocation, isStandIn } from './credential-values.js';

/**
 * What a name says about the values that hang under it.
 *
 * A JSON key is read ONCE, where it is, and the answer is handed down to every string under it.
 * Reading the key again for each item of a list makes the cost the length of the key times the
 * number of items, and a repository can commit a key of a million characters above a list of
 * hundreds of thousands: that took one call of the reader minutes.
 *
 * Two rules read a value under a name. Core's: a value of 12 characters or more, in one piece and
 * not a stand-in, under a name its own list calls secret. And a shorter one for the names that say
 * it plainly (`password`, `token`, `api key`, `auth` ...): this reader leans toward "it is a
 * credential", because a false alarm costs a byte copy and a miss costs a credential in one more
 * place, and a development password is not 12 characters long.
 */

export interface NameFacts {
  /**
   * Core's rule for names applies to this name: it says secret (`token`, `password`, `auth`,
   * `key` ...) and is not a location or a label (`_url`, `_path`, `_name` ...). Core owns that
   * list, and is asked, so that the two readers of an environment never disagree about a name.
   */
  readonly core: boolean;
  /** The name says plainly that its value is secret, and is not a label for something else. */
  readonly secret: boolean;
  /** A person chose the value (a password, a passphrase), so it may hold spaces and digits. */
  readonly personal: boolean;
  /** The name is that of an authorization header, or holds the word. */
  readonly authorization: boolean;
}

const AUTHORIZATION = 'authorization';

/**
 * The words that say plainly that a value is secret, anywhere in a name: `DB_PASSWORD`, `authToken`,
 * `exaApiKey`, `X-Api-Key`, `MY_APIKEY`. `author` is taken out of the name first (see below).
 */
const SECRET_WORDS =
  /password|passwd|passphrase|passcode|pwd|secret|token|api[-_ ]?key|apikey|auth|credential|private[-_ ]?key|access[-_ ]?key/i;
const PERSONAL_WORDS = /pass(?:word|wd|phrase|code)|pwd/i;
/** `author`, `authors` and `authority` begin with `auth` and are not about authentication. */
const AUTHOR = /author(?!iz)/gi;
/** Words that say it only when they stand alone: `DB_PASS`, `REDIS_PW`, and not `bypass`. */
const BARE_SECRET_WORDS: ReadonlySet<string> = new Set(['pass', 'pw']);

/**
 * The last word of a name says what the value is. These say it is not itself secret, whatever
 * else the name holds: where something is (`authUrl`), what it is called (`secretId`), how it
 * works (`authMethod`), what runs to get it (`apiKeyHelper`, `awsAuthRefresh`), or how much of
 * something there is (`MAX_THINKING_TOKENS`, `tokenLimit`). Core's list has the snake-case ones;
 * a config written in camel case needs these too.
 */
const LABEL_WORDS: ReadonlySet<string> = new Set([
  'url',
  'uri',
  'endpoint',
  'host',
  'hostname',
  'domain',
  'path',
  'file',
  'dir',
  'directory',
  'helper',
  'command',
  'cmd',
  'script',
  'exec',
  'refresh',
  'export',
  'type',
  'mode',
  'method',
  'scheme',
  'flow',
  'scope',
  'scopes',
  'header',
  'headers',
  'name',
  'id',
  'region',
  'provider',
  'issuer',
  'audience',
  'realm',
  'tokens',
  'limit',
  'limits',
  'count',
  'size',
  'length',
  'timeout',
  'ttl',
  'expiry',
  'expires',
  'expiration',
  'port',
  'prefix',
  'suffix',
  'version',
  'format',
]);

/** Query-string parameters that are a credential there and are not a credential as a bare name. */
const QUERY_SECRET_NAMES: ReadonlySet<string> = new Set(['key', 'sig', 'signature']);

/**
 * A value that passes every test core has for a value (long enough, one piece, no placeholder, no
 * path, no URL), so that when core is asked about it, only the name decides.
 */
const PROBE = 'Zq7Zq7Zq7Zq7Zq7';

/** The longest stretch of a value that is read, as core reads at most this much of a line. */
const MAX_VALUE_CHARS = 4096;
/** Shorter values are not read under a name: too many of them are ordinary words. */
export const SHORT_SECRET_MIN = 4;

const isUpper = (code: number): boolean => code >= 0x41 && code <= 0x5a;
const isLower = (code: number): boolean => code >= 0x61 && code <= 0x7a;
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isAlnum = (code: number): boolean => isUpper(code) || isLower(code) || isDigit(code);

/**
 * The words of a name, in lower case: split at anything that is not a letter or a digit and where
 * a capital begins a word (`apiKeyHelper`, `URLPath`, `MAX_THINKING_TOKENS`). One pass.
 */
export function wordsOf(name: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i <= name.length; i += 1) {
    const code = i < name.length ? name.charCodeAt(i) : 0;
    const inWord = isAlnum(code);
    if (start === -1) {
      if (inWord) start = i;
      continue;
    }
    const prev = name.charCodeAt(i - 1);
    const next = i + 1 < name.length ? name.charCodeAt(i + 1) : 0;
    const capital =
      isUpper(code) && (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next)));
    if (!inWord || capital) {
      words.push(name.slice(start, i).toLowerCase());
      start = inWord ? i : -1;
    }
  }
  return words;
}

/** Whether core takes `name` for the name of a secret: its list of words, and its list of locations. */
const coreSaysSecret = (name: string): boolean => extractEnv({ [name]: PROBE }).length > 0;

export function nameFacts(name: string): NameFacts {
  const words = wordsOf(name);
  const core = coreSaysSecret(name);
  const label = LABEL_WORDS.has(words[words.length - 1] ?? '');
  const bare = words.some((word) => BARE_SECRET_WORDS.has(word));
  const named = name.replace(AUTHOR, '');
  const says = bare || SECRET_WORDS.test(named);
  // Core's list has no `pw`. Asked about the name with a word it knows in front, it answers only
  // for the end of the name, which is where it looks for a location (`_url`, `_path`).
  const allowed = core || (says && coreSaysSecret(`token_${name}`));
  const secret = says && allowed && !label;
  return {
    core,
    secret,
    personal: secret && (bare || PERSONAL_WORDS.test(named)),
    authorization: name.toLowerCase().includes(AUTHORIZATION),
  };
}

/**
 * The facts of the name of a parameter in a URL's query string or fragment. A few names that are
 * not credentials by themselves (`key`, `sig`) are credentials there.
 */
export function parameterFacts(name: string, inQuery: boolean): NameFacts {
  const facts = nameFacts(name);
  return inQuery && QUERY_SECRET_NAMES.has(name.toLowerCase()) ? { ...facts, secret: true } : facts;
}

/**
 * A value under a name that says plainly it is secret, from four characters up: the reading that
 * core's twelve-character rule leaves out.
 */
function shortSecret(facts: NameFacts, value: string): boolean {
  if (!facts.secret || value.length < SHORT_SECRET_MIN) return false;
  if (hasSpace(value) && !facts.personal) return false;
  return !isLocation(value);
}

/**
 * Whether `value`, under a name with these facts, is a secret. A value of a known vendor's shape
 * is one under any name. Any other value in one piece that is not a stand-in or a location is one
 * under a name core calls secret if it is 12 characters or more, and under a name that says it
 * plainly if it is 4 or more (or has spaces in it, if a person chose it).
 */
export function secretUnderName(facts: NameFacts, value: string): boolean {
  const read = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value;
  if (isStandIn(read)) return false;
  if (isSecretValue(read) && (facts.core || looksLikeVendorToken(read))) return true;
  return shortSecret(facts, read);
}
