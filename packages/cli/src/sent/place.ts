// Where a key went, in five tiers, most external first. When it is not sure which of two tiers a
// key is in, every reader here picks the more external one. Each tier says what was seen, never
// what did not happen: a key is in a milder tier because no send of it was seen, not because one
// was ruled out, and a log cannot rule one out.
//
//   third_party  SENT TO ANOTHER COMPANY   a request carried it to a host that is not the key's own service
//   maybe        MAYBE SENT                 it may have left: a program ran with it, a file later run, this machine's own address
//   seen         SEEN BY THE AI             your agent's model saw it: in what the AI read or wrote, in a command that only reads
//   own_service  USED WITH ITS OWN SERVICE  an OpenAI key sent to api.openai.com: what the key is for
//   blocked      BLOCKED BEFORE IT RAN      Claude Code records the call as refused by you or blocked by Stroq
//
// A key that turns up in several places is reported under the most external one it reached.
import { isOwnHost, storesContent, type KeyLabel } from './own-service.js';

export type Tier = 'third_party' | 'maybe' | 'seen' | 'own_service' | 'blocked';

/** Most external first: the order a report lists them in, and the order a key's places are ranked. */
export const TIERS: readonly Tier[] = ['third_party', 'maybe', 'seen', 'own_service', 'blocked'];

export const tierRank = (tier: Tier): number => TIERS.indexOf(tier);

/**
 * How a key's places are ranked: by tier, except that a stopped call to another company ranks
 * just below a sent one. That a call was stopped is read from its result, which a command can
 * print, so it must not be hidden behind the AI having also seen the key.
 */
export const placeRank = (place: Pick<Place, 'tier' | 'wouldBe'>): number =>
  place.tier === 'blocked' && place.wouldBe === 'third_party' ? 0.5 : tierRank(place.tier);

/** How the key got where it went. Each is printed as a fixed phrase. */
export type Route =
  | 'command'
  | 'command-near'
  | 'command-ran'
  | 'command-unread'
  | 'post'
  | 'secret-store'
  | 'ssh'
  | 'git-push'
  | 'publish'
  | 'web-fetch'
  | 'web-search'
  | 'mcp'
  | 'write'
  | 'write-script'
  | 'write-sent'
  | 'write-push'
  | 'arguments'
  | 'result'
  | 'prompt'
  | 'reply'
  | 'record'
  | 'cut';

/**
 * What a bound of the check dropped, on a `cut` place: a variable past those a session follows,
 * a key file past those a pattern is checked against, a folder past those a session follows.
 */
export type Cut = 'variables' | 'key-files' | 'folders';

/**
 * What became of a file the AI wrote with the key: the command in it (`write-script`), the call
 * that later sent it or ran it (`write-sent`), or a push or publish it may have gone out with
 * (`write-push`).
 */
export interface Then {
  readonly route: Route;
  readonly host: string | null;
  /** When, as a record gave it: ISO 8601 or null once a report holds it. */
  readonly at: string | null;
  /** The program of that command, as a phrase prints it. */
  readonly detail?: string;
  /** For `write-script`: where the command in the file puts the key, were the file run. */
  readonly tier?: Tier;
}

/** A push or publish the session ran, which a file written earlier may have gone out with. */
export interface Push extends Then {
  readonly route: 'git-push' | 'publish';
}

export interface Place {
  readonly tier: Tier;
  readonly route: Route;
  /** The tool the call was made with. */
  readonly tool?: string;
  /** The command word, the MCP server, or the file: what the route's phrase names. */
  readonly detail?: string;
  /** The host the key was sent to. */
  readonly host?: string;
  /** The host is this machine: localhost or a loopback address. */
  readonly local?: true;
  /** The key was in the part of a large output that Claude Code saved to a file. */
  readonly spilled?: true;
  /** Who stopped the call: the user, or Stroq. Set only on a `blocked` place. */
  readonly blocked?: 'stroq' | 'user';
  /**
   * On a `blocked` place: where the call would have put the key had it run. That it was stopped
   * is read from its result, which a command can print, so this is kept and shown.
   */
  readonly wouldBe?: Tier;
  /**
   * The log says the call was stopped, in a shape that does not prove it: a Codex or Cursor result
   * that starts with Stroq's reason, or a denial in Stroq's own log. The place stays where the call
   * would have gone; the report adds "the log says it was stopped".
   */
  readonly saidStopped?: true;
  /** A claude.ai connector: the MCP server runs at Anthropic for another service. */
  readonly connector?: true;
  /** For `secret-store`: the hosting service the key was stored at, by a name from a table. */
  readonly service?: string;
  /** For `write-script`, `write-sent` and `write-push`: what became of the written file. */
  readonly then?: Then;
  /** For `cut`: which bound of the check dropped what may have carried the key. */
  readonly cut?: Cut;
}

/** IPv4 in dotted form, each part 0-255. */
function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

/**
 * Whether a host is this machine itself: `localhost`, a loopback address. Not the local network:
 * a private address or a `.local` name is another machine, which ssh logs in to.
 */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  const ip = ipv4(h);
  return ip !== null && ip[0] === 127;
}

/** A key's name and source, and its value, for the pieces of it no host may hold. */
export type KeyOf = KeyLabel & { readonly value: string };

/** Whether a host holds six characters of the key, in any case: the key sent as a name. */
export function holdsPiece(host: string, key: KeyOf): boolean {
  const value = key.value.toLowerCase();
  const name = host.toLowerCase();
  if (value === '') return false;
  for (let at = 0; at + 6 <= name.length; at += 1)
    if (value.includes(name.slice(at, at + 6))) return true;
  return false;
}

/** What else decides where a request went, beside its hosts. */
export interface RequestFacts {
  /** A destination of the request was not read: no host, too many, or a word that may be one. */
  readonly unread?: boolean;
  /** A word in the command can send it somewhere it does not name (a proxy, a resolve). */
  readonly routed?: boolean;
  /** It sends a body or uploads a file. */
  readonly body?: boolean;
}

/**
 * Where a request to `hosts` put a key. Its own service only when every host is an exact host of
 * that service's API, every destination was read, nothing routes it elsewhere, no host holds a
 * piece of the key, and a service that keeps what it is sent was sent no body. "Maybe", on this
 * machine, when every host is this machine: a local program may send it on. Anything else is
 * another company: the first host that is neither, or a host Stroq could not read.
 */
export function hostPlace(
  hosts: readonly string[],
  key: KeyOf,
  base: Omit<Place, 'tier' | 'host' | 'local'>,
  facts: RequestFacts = {},
): Place {
  const usable = hosts.map((h) => h.toLowerCase()).filter((h) => h !== '');
  const foreign = usable.find((h) => !isLoopback(h) && !isOwnHost(key, h));
  if (foreign !== undefined) return { ...base, tier: 'third_party', host: foreign };
  if (usable.length === 0 || facts.unread === true || facts.routed === true)
    return { ...base, tier: 'third_party' };
  const first = usable[0] as string;
  if (usable.every(isLoopback)) return { ...base, tier: 'maybe', host: first, local: true };
  // Own hosts beside this machine's: not all of it was the key's own use.
  if (!usable.every((h) => isOwnHost(key, h))) return { ...base, tier: 'third_party' };
  if (usable.some((h) => holdsPiece(h, key))) return { ...base, tier: 'third_party', host: first };
  // What a service that keeps what it is sent was sent in a body is published there.
  if (facts.body === true && storesContent(key))
    return { ...base, tier: 'third_party', host: first, route: 'post' };
  return { ...base, tier: 'own_service', host: first };
}

/**
 * Within ONE call, where it sent the key ranks above what the AI saw: the AI wrote every call,
 * so a call to the key's own service is its own-service use, not a sighting. Across calls a key
 * is ranked by `TIERS`, where the AI seeing it outranks a use with its own service.
 */
const CALL_ORDER: readonly Tier[] = ['third_party', 'maybe', 'own_service', 'seen', 'blocked'];

/** The farther of two places one call reached; the first when they tie. */
export const farther = (a: Place, b: Place): Place =>
  CALL_ORDER.indexOf(b.tier) < CALL_ORDER.indexOf(a.tier) ? b : a;
