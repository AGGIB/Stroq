// The moments about keys: keys that left this machine, and keys the AI saw. One moment for what happened
// once: ten keys sent to one host in one session, or ten keys the AI saw in one session, are one moment
// that lists the keys, not ten that push everything else off the card.
//
// What is grouped is the same session and the same destination; a key the AI saw is grouped by session.
// When the program that sent the keys is ssh, scp, sftp or rsync (the program name the finding already
// records), the destination may well be the user's own server, and the words say so: "If that server is
// yours, nothing to do; if not, treat them as leaked." That is a choice of words and nothing else: it
// reads no ssh config and changes no count, no place and no order. A key's name, source and host came from
// a file or a session, so each goes through `clean` as everywhere on the card.
import { compareFindings, type Finding } from '../sent/findings.js';
import { describePlace, doLine, when } from '../sent/phrases.js';
import { isAgent, sessionRows, withTranscript, type SessionPlace } from './moment-parts.js';
import type { Moment } from './schema.js';
import { clean, plural, shortPath } from './text.js';

/**
 * A finding of one key in one session of the window, with the session's place in the window. What groups
 * findings into a moment is that number and not the session's name: a name that holds a piece of a key
 * is printed as a fixed phrase, the same for many sessions.
 */
export interface PlacedFinding extends Finding {
  readonly sessionNo: number;
}

/** The programs that log in to a server and copy or run something there. */
const SSH_PROGRAMS: ReadonlySet<string> = new Set(['ssh', 'scp', 'sftp', 'rsync']);

/** Whether the program that sent a key (as the finding records it) is one that logs in to a server. */
const viaSsh = (f: Finding): boolean => SSH_PROGRAMS.has(f.place.detail ?? '');

/** The most keys a moment lists by name; `stroq show` rows are 16 at most, the last says how many more. */
const LISTED = 15;

type Draft = Omit<Moment, 'n'>;

/** Groups in the order their first member came, each with its members in order. */
function groupBy<F extends Finding>(findings: readonly F[], keyOf: (f: F) => string): F[][] {
  const groups = new Map<string, F[]>();
  for (const f of findings) {
    const key = keyOf(f);
    const held = groups.get(key);
    if (held === undefined) groups.set(key, [f]);
    else held.push(f);
  }
  return [...groups.values()];
}

function placeOf(f: Finding): SessionPlace | null {
  const agent = f.session.agent;
  return isAgent(agent)
    ? { agent, id: f.session.id, path: f.session.path, cwd: f.session.cwd }
    : null;
}

function oneKeyRows(f: Finding, home: string): [string, string][] {
  return [
    ['Key', clean(f.name, 80)],
    ['Kept in', shortPath(f.source, home, 70)],
    ['Where it went', clean(describePlace(f.place), 200)],
    ['When', when(f.at)],
    ['What to do', clean(doLine(f), 200)],
  ];
}

/** The rows of a moment about several keys: how many, where, when, what to do, and the keys. */
function manyKeysGroups(
  group: readonly Finding[],
  home: string,
  advice: string,
  went: string,
): { title: string; rows: [string, string][] }[] {
  const first = group[0] as Finding;
  const listed = group.slice(0, group.length > 16 ? LISTED : 16);
  const keys = listed.map((f): [string, string] => [
    '',
    `${clean(f.name, 60)}, kept in ${shortPath(f.source, home, 50)}`,
  ]);
  if (listed.length < group.length) keys.push(['', `and ${group.length - listed.length} more`]);
  return [
    {
      title: 'What happened',
      rows: [
        ['Keys', plural(group.length, 'key', 'keys')],
        ['Where it went', clean(went, 200)],
        ['When', when(first.at)],
        ['What to do', clean(advice, 200)],
      ],
    },
    { title: 'The keys', rows: keys },
  ];
}

function moment(
  kind: Moment['kind'],
  line: string,
  group: readonly Finding[],
  home: string,
  advice: string,
  went?: string,
): Draft {
  const first = group[0] as Finding;
  const session = placeOf(first);
  const what =
    group.length === 1
      ? [{ title: 'What happened', rows: oneKeyRows(first, home) }]
      : manyKeysGroups(group, home, advice, went ?? describePlace(first.place));
  return {
    kind,
    line,
    ...(session === null ? {} : { session }),
    groups: [
      ...what,
      ...(session === null
        ? []
        : [{ title: 'Where to find it', rows: sessionRows(session, home) }]),
    ],
    next: session === null ? [] : withTranscript('sent', session.path),
  };
}

const REVOKE_EACH = 'revoke each key where it was issued, then update where it is kept';

function sentMoment(group: readonly Finding[], home: string): Draft {
  const first = group[0] as Finding;
  const host = first.place.host === undefined ? 'another company' : clean(first.place.host, 60);
  const one = group.length === 1;
  const subject = one ? clean(first.name, 60) : `${group.length} keys`;
  const treat = one ? 'treat that key as leaked' : 'treat them as leaked';
  // A server the user logs in to may be their own; the words say so, and say what to do either way.
  const line = viaSsh(first)
    ? `Your agent sent ${subject} to ${host} over ssh. If that server is yours, nothing to do; if not, ${treat}.`
    : `Your agent sent ${subject} to ${host}. ${treat.charAt(0).toUpperCase()}${treat.slice(1)}.`;
  const advice = viaSsh(first)
    ? `if ${host} is yours, nothing to do. If not, ${REVOKE_EACH}`
    : REVOKE_EACH;
  return moment('key-sent', line, group, home, advice);
}

/** A key a request may have sent without holding it: told as a maybe, and not counted as sent. */
function maybeMoment(group: readonly Finding[], home: string): Draft {
  const first = group[0] as Finding;
  const host = first.place.host === undefined ? 'another company' : clean(first.place.host, 60);
  const one = group.length === 1;
  const subject = one ? clean(first.name, 60) : `${group.length} keys`;
  const line = `Your agent may have sent ${subject} to ${host}. The command that made the request did not hold ${one ? 'it' : 'them'}, so Stroq cannot tell.`;
  const went = describePlace(first.place);
  return moment(
    'key-maybe',
    line,
    group,
    home,
    'check what that command sent; rotate each key it carried',
    one
      ? went
      : went.replaceAll('this key was', 'these keys were').replaceAll('this key', 'these keys'),
  );
}

function seenMoment(group: readonly Finding[], home: string): Draft {
  const first = group[0] as Finding;
  const folder = first.session.cwd === null ? '' : ` in ${shortPath(first.session.cwd, home, 30)}`;
  if (group.length > 1)
    return moment(
      'key-seen',
      `The AI saw ${group.length} keys in one session${folder}.`,
      group,
      home,
      'rotate them if that matters',
    );
  const name = clean(first.name, 60);
  const read =
    first.place.tool === 'Read' && first.place.route === 'result' ? first.place.detail : undefined;
  const line =
    read === undefined
      ? `The AI saw ${name}: ${clean(describePlace(first.place), 90)}.`
      : `Your agent read ${clean(read.slice(read.lastIndexOf('/') + 1), 40)}${folder}; the AI saw ${name}.`;
  return moment('key-seen', line, group, home, '');
}

/**
 * The key moments, by kind: each is one moment for a session and a destination, made from the findings
 * of that session and no other. `findings` has one for each key in each session it was found in, so a
 * key found in two places is in two moments; the moments come in the order findings are listed in (a
 * decoy first, then the earliest).
 */
export function keyMoments(
  findings: readonly PlacedFinding[],
  home: string,
): { readonly sent: Draft[]; readonly maybe: Draft[]; readonly seen: Draft[] } {
  const ordered = [...findings].sort(compareFindings) as PlacedFinding[];
  const sentTo = (f: PlacedFinding): string =>
    `${f.sessionNo}\u0000${f.place.host ?? ''}\u0000${viaSsh(f) ? 'ssh' : ''}`;
  return {
    sent: groupBy(
      ordered.filter((f) => f.tier === 'third_party'),
      sentTo,
    ).map((g) => sentMoment(g, home)),
    maybe: groupBy(
      ordered.filter((f) => f.tier === 'maybe' && f.place.route === 'linked'),
      sentTo,
    ).map((g) => maybeMoment(g, home)),
    seen: groupBy(
      ordered.filter((f) => f.tier === 'seen'),
      (f) => String(f.sessionNo),
    ).map((g) => seenMoment(g, home)),
  };
}
