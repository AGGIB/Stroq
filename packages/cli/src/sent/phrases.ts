// The fixed words for where a key went and what to do about it.
//
// "Went to" means the call that ran held the key, not that the host kept it. Each route has
// one phrase, so the same finding always reads the same way.
import type { Finding } from './findings.js';
import { TIERS, type Cut, type Place, type Tier } from './place.js';
import { TOOL_RUNNERS } from './where.js';

/** `2026-10-11 14:02 UTC`, or `an unknown time`. */
export function when(iso: string | null): string {
  if (iso === null || Number.isNaN(Date.parse(iso))) return 'an unknown time';
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Said under the findings of every report, and on the card: what a log can show of a send. */
export const SEND_LIMIT =
  'Stroq names a send only when it sees the key in the command that sent it. A script, a file or a variable can carry a key out without showing it.';

/** What a count of keys in each place is called: `2 seen by the AI`. */
const COUNTED: Readonly<Record<Tier, string>> = {
  third_party: 'sent to another company',
  maybe: 'maybe sent',
  seen: 'seen by the AI',
  own_service: 'used with its own service',
  blocked: 'blocked before it ran',
};

/** The places keys were found in, as counts, most external first: none for a place with none. */
export function countParts(found: Readonly<Record<Tier, number>>): string[] {
  return TIERS.filter((tier) => found[tier] > 0).map((tier) => `${found[tier]} ${COUNTED[tier]}`);
}

/** The word before where a key went, by place. */
export const LABEL: Readonly<Record<Tier, string>> = {
  third_party: 'went to',
  maybe: 'went to',
  seen: 'seen in',
  own_service: 'went to',
  blocked: 'stopped',
};

const article = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

function mcpPhrase(place: Place): string {
  const name = `"${place.detail ?? 'unknown'}"`;
  if (place.connector === true) return `the claude.ai connector ${name}`;
  if (place.tier === 'maybe') {
    if (place.local === true) return `MCP server ${name} on this machine, which may send it on`;
    return place.host === undefined
      ? `MCP server ${name}, whose settings Stroq did not find`
      : `MCP server ${name}, whose settings now name ${place.host}; where it pointed during the session is not recorded`;
  }
  return place.host === undefined
    ? `MCP server ${name}`
    : `${place.host}, through MCP server ${name}`;
}

function resultPhrase(place: Place): string {
  const saved = place.spilled === true ? ' (the part saved to a file)' : '';
  if (place.tool === 'Read' || place.tool === 'Grep')
    return `the output of ${article(place.tool)}${place.detail === undefined ? '' : ` of ${place.detail}`}${saved}`;
  if (place.detail !== undefined) return `the output of ${article(place.detail)} command${saved}`;
  return `the output of ${article(place.tool ?? 'tool')} call${saved}`;
}

/** What is printed for a host no reader could read. */
const UNREAD_HOST = 'a host Stroq could not read';

/** The host a place names, with what is known of whose it is. */
function hostWords(place: Place): string {
  const host = place.host ?? UNREAD_HOST;
  return place.local === true ? `this machine (${host})` : host;
}

/** What is said of a call whose log says it was stopped, which does not prove it. */
const SAID_STOPPED = ' (the log says it was stopped)';

/** Where a key went, in words, and what the log says of a stop it does not prove. */
export function describePlace(place: Place): string {
  const words = routeWords(place);
  return place.saidStopped === true ? `${words}${SAID_STOPPED}` : words;
}

function routeWords(place: Place): string {
  const host = place.host ?? UNREAD_HOST;
  const word = place.detail ?? 'shell';
  const stopped =
    place.blocked === 'stroq'
      ? ' (Stroq blocked it)'
      : place.blocked === 'user'
        ? ' (you refused it)'
        : '';
  const local = hostWords(place);
  switch (place.route) {
    case 'command':
      return `${local}, in ${article(word)} command${stopped}`;
    case 'command-near':
      return `${host}? It was in a command that also made a request there${stopped}`;
    case 'command-ran':
      // A tool that runs what it is given (`js`, a skill, a slash command), not a shell's program.
      if (place.detail === undefined && place.tool !== undefined && TOOL_RUNNERS.has(place.tool))
        return `${article(place.tool)} call, which runs what it is given: Stroq could not tell where this key went${stopped}`;
      return `${article(word)} command: a program ran with this key; Stroq could not tell where it went${stopped}`;
    case 'command-unread':
      return `${article(word)} command Stroq cannot read all of, so it may have sent it on${stopped}`;
    case 'post':
      return `${local}, posted by ${article(word)} command${stopped}`;
    case 'secret-store':
      return `${place.service ?? 'a hosting service'} (${host}), stored as a secret by ${article(word)} command${stopped}`;
    case 'ssh':
      return `${local}, over ${word}${stopped}`;
    case 'git-push':
      return `${local}, in a git push${stopped}`;
    case 'publish':
      return `${local}, in a package publish (${word})${stopped}`;
    case 'web-fetch':
      return place.tool === undefined || place.tool === 'WebFetch'
        ? `${local}, in a WebFetch request${stopped}`
        : `${local}, in ${article(place.tool)} call${stopped}`;
    case 'web-search':
      return `a web search${stopped}`;
    case 'mcp':
      return `${mcpPhrase(place)}${stopped}`;
    case 'write':
      return `a file the AI wrote${place.detail === undefined ? '' : `: ${place.detail}`}${stopped}`;
    case 'write-script': {
      const program = place.then?.detail ?? 'shell';
      const to = place.host === undefined ? 'that may send it on' : `that sends it to ${local}`;
      return `${place.detail ?? 'a file'}, written by the AI: it holds ${article(program)} command ${to}${stopped}`;
    }
    case 'write-sent': {
      const then = place.then;
      const program = then?.detail ?? 'shell';
      const at = when(then?.at ?? null);
      const file = place.detail ?? 'a file';
      if (then?.route === 'command-unread')
        return `${file}, written by the AI, past the files and commands Stroq follows, so it may have been sent${stopped}`;
      if (then?.route === 'command-near') {
        const to = place.host === undefined ? '' : ` to ${local}`;
        return `${file}, written by the AI; then ${article(program)} command uploaded files${to} at ${at}: check whether it was one of them${stopped}`;
      }
      if (then?.route === 'command-ran') {
        const sends = place.host === undefined ? '' : `; it sends it to ${local}`;
        return `${file}, written by the AI, then run by ${article(program)} command at ${at}${sends}${stopped}`;
      }
      return `${local}: ${file}, written by the AI, then sent by ${article(program)} command at ${at}${stopped}`;
    }
    case 'write-push': {
      const push = place.then;
      const how = push?.route === 'publish' ? 'a package publish' : 'a git push';
      const to = push?.host === null || push?.host === undefined ? '' : ` to ${push.host}`;
      return `${place.detail ?? 'a file'}, written by the AI, then ${how}${to} at ${when(push?.at ?? null)}`;
    }
    case 'arguments':
      return `the arguments of ${article(place.tool ?? 'tool')} call${stopped}`;
    case 'result':
      return resultPhrase(place);
    case 'prompt':
      return 'a message sent to the AI';
    case 'reply':
      return "the AI's reply";
    case 'record':
      return 'the session log, outside any call or message Stroq reads, so it may have been sent';
    case 'cut':
      return CUT_WORDS[place.cut ?? 'variables'];
  }
}

/** What a place cut short by a bound of the check says: the check stopped there. */
const CUT_WORDS: Readonly<Record<Cut, string>> = {
  variables:
    'a variable past what Stroq follows in one session (4,096 variables), so a later command may have sent it',
  'key-files':
    'a command that names files by a pattern, past what Stroq follows (256 key files), so it may have sent the file this key is in',
  folders:
    'a command that names files by a pattern or `.` in a folder past what Stroq follows (64 folders), so it may have sent the file this key is in',
};

/** The update the source needs once the key is replaced. */
const updateSource = (f: Finding): string =>
  f.source === 'env' ? 'your shell environment' : f.source;

/** What to do about a finding. */
export function doLine(f: Finding): string {
  const at = f.rotate === null ? 'where it was issued' : `at ${f.rotate}`;
  if (f.canary === true && f.tier !== 'blocked')
    return f.tier === 'seen'
      ? 'nothing to rotate: it is a decoy. Look at what led the agent to read it'
      : 'nothing to rotate: it is a decoy. Look at what the agent read before this call';
  const rotate =
    f.rotate === null ? 'rotate it if that matters' : `rotate it if that matters: ${f.rotate}`;
  switch (f.tier) {
    case 'third_party':
      // What a command posted (an issue, a comment, a gist) stays where it was posted.
      return f.place.route === 'post'
        ? `revoke it ${at}, then update ${updateSource(f)}; delete what the command posted`
        : `revoke it ${at}, then update ${updateSource(f)}`;
    case 'maybe':
      if (f.place.route === 'secret-store')
        return `If you meant to store this key in ${f.place.service ?? 'that service'}, nothing to do. If not, rotate it.`;
      if (f.place.route === 'write-push')
        return `check ${f.place.detail ?? 'that file'} was not in what you pushed; if it was, rotate it`;
      if (f.place.route === 'write-script')
        return `check whether ${f.place.detail ?? 'that file'} was run; if it was, rotate it`;
      if (f.place.route === 'write-sent')
        return `check where ${f.place.detail ?? 'that file'} went; rotate it if it left this machine`;
      if (f.place.route === 'ssh')
        return `check what ${f.place.host ?? 'the server'} kept; rotate it if the server is not yours`;
      if (f.place.route === 'mcp')
        return `check what that MCP server does with it; rotate it if it sends it on`;
      if (f.place.route === 'record')
        return 'look in the session for what carried it; rotate it if it left this machine';
      if (f.place.route === 'cut')
        return "Stroq's check was cut short here: look in the session for what carried it; rotate it if it left this machine";
      return 'check what that command did with it; rotate it if it left this machine';
    case 'seen':
      return `your agent's model saw it; ${rotate}`;
    case 'own_service':
      return `if you did not expect this use, revoke it ${at}`;
    case 'blocked':
      return f.place.wouldBe === 'third_party'
        ? `check that the call did not run: only its result says it was stopped. If it ran, revoke it ${at}`
        : `the call did not run, and your agent's model saw the key in it; ${rotate}`;
  }
}
