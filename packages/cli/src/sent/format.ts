// The report as text: what was found, as counts, first, then what was compared, then each key
// under the place it went, most external first. Every finding ends with what to do.
//
// It says only what it saw. A key is in a milder place because no send of it was seen, never
// because one was ruled out, so no line says a key did not go somewhere: not the first line, not a
// heading, not a do-line. The words are chosen for someone who has never heard of Stroq: "sent to
// another company", "seen by the AI". A host, a file or a folder printed here came from a session,
// so control characters in it are written out as visible escapes.
import { displayPath, neutralizeControls } from '@stroq/core';
import { SPILL_BUDGET_BYTES } from '../replay/spilled.js';
import type { Finding } from './findings.js';
import { TIERS, type Tier } from './place.js';
import type { SentReport } from './report.js';
import { inTier, keysLeftOut, stoppedTowardOthers } from './report.js';
import { countParts, describePlace, doLine, LABEL, SEND_LIMIT, when } from './phrases.js';
import { MAX_FOLDER_BYTES, MAX_FOLDER_ENV_FILES, MAX_KEYS } from './keys.js';
import { CANARY_SOURCE } from './session-canaries.js';

const AGENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'audit-log': "Stroq's log",
};

const HEADINGS: Readonly<Record<Tier, string>> = {
  third_party: 'SENT TO ANOTHER COMPANY: rotate these today',
  maybe: 'MAYBE SENT: check these',
  seen: "SEEN BY THE AI: your agent's model saw these keys",
  own_service: 'USED WITH ITS OWN SERVICE: check you expected this',
  blocked: 'BLOCKED BEFORE IT RAN: the AI still saw these keys',
};

/** Findings printed per place; the rest are counted, and all are in `--json`. */
const MAX_SHOWN = 25;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const safe = (text: string): string => neutralizeControls(text);

const day = (iso: string | null): string =>
  iso === null || Number.isNaN(Date.parse(iso))
    ? 'an unknown day'
    : new Date(iso).toISOString().slice(0, 10);

/** Said after the first line whenever anything was not checked: the first line is no all-clear. */
const NOT_EVERY_KEY = 'Not every key was compared: see Not checked.';

/**
 * The first lines: what was found, as counts, and on the lines after it what keys left out of the
 * comparison, session files that could not be read and a search cut short leave unread.
 */
function verdictLines(report: SentReport): string[] {
  const lines = [
    ...countLines(report),
    ...(report.notChecked.length > 0 && report.keys.compared > 0 ? [NOT_EVERY_KEY] : []),
  ];
  const unread = report.unreadable;
  const cut = report.searchCut ?? 0;
  if (unread === 0 && cut === 0) return lines;
  const gaps = [
    ...(unread > 0 ? [`${plural(unread, 'session file', 'session files')} could not be read`] : []),
    ...(cut > 0
      ? [`the search for keys was cut short in ${plural(cut, 'session text', 'session texts')}`]
      : []),
  ];
  const first = gaps.join(' and ');
  return [...lines, `${first.charAt(0).toUpperCase()}${first.slice(1)}. See "Not checked" below.`];
}

/** What was found, as counts: never a claim that a key did not go somewhere. */
function countLines(report: SentReport): string[] {
  const k = report.keys;
  if (k.compared === 0 && report.scope !== 'audit-log')
    return keysLeftOut(k)
      ? ['No keys were compared: key files were not read whole. See "Not checked" below.']
      : ['No keys found on this machine, so there was nothing to look for.'];
  const found = Object.fromEntries(TIERS.map((t) => [t, inTier(report, t).length])) as Record<
    Tier,
    number
  >;
  const n = report.findings.length;
  const parts = countParts(found).join(', ');
  if (report.scope === 'audit-log')
    return [
      n === 0
        ? "Stroq's log recorded no key in the calls of this session."
        : `Stroq's log recorded ${plural(n, 'key', 'keys')} in the calls of this session: ${parts}.`,
    ];
  if (n === 0)
    return [
      k.compared === 1
        ? "Your 1 key's value does not appear in these session logs."
        : `None of your ${k.compared} keys' values appear in these session logs.`,
    ];
  return [
    `${n} of your ${plural(k.compared, 'key', 'keys')} ${n === 1 ? 'appears' : 'appear'} in your agent sessions: ${parts}.`,
    ...canaryLines(report),
    ...stoppedLines(report),
  ];
}

/** A canary sent away: nothing to rotate, and the sign that something steered the agent. */
function canaryLines(report: SentReport): string[] {
  const n = inTier(report, 'third_party').filter((f) => f.canary === true).length;
  if (n === 0) return [];
  return [
    `${n === 1 ? 'A canary' : `${n} canaries`} you planted with \`stroq canary\` went to another company. Look at what the agent read before it.`,
  ];
}

/** Calls to another company the session records as stopped: only their results say so. */
function stoppedLines(report: SentReport): string[] {
  const n = stoppedTowardOthers(report);
  if (n === 0) return [];
  return [
    `${plural(n, 'key was', 'keys were')} in a call to another company that the session records as stopped. Check below.`,
  ];
}

/** ` (Claude Code 388, Codex 24)`, or ` (Claude Code)` when one agent recorded them all. */
function agentList(report: SentReport): string {
  const seen = Object.entries(report.sessions.agents);
  if (seen.length === 1) return ` (${AGENTS[seen[0]?.[0] ?? ''] ?? seen[0]?.[0]})`;
  const parts = seen.map(([agent, s]) => `${AGENTS[agent] ?? agent} ${s?.sessions ?? 0}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/** ` on 2026-10-15`, or `, 2026-09-20 to 2026-10-19`. */
function span(report: SentReport): string {
  const from = day(report.sessions.first);
  const to = day(report.sessions.last);
  return from === to ? ` on ${from}` : `, ${from} to ${to}`;
}

function sessionLines(report: SentReport): string[] {
  const s = report.sessions;
  if (report.scope === 'audit-log')
    return [
      "Checked Stroq's own log of this session. It keeps the keys Stroq saw in a call,",
      'not what came back. `stroq sent --last` reads the agent’s own record.',
    ];
  if (report.scope === 'last') {
    const more =
      s.inProject !== undefined && s.inProject > 1
        ? [`This project has ${s.inProject} sessions. Check them all with \`stroq sent --here\`.`]
        : [];
    return [
      `Checked the newest session of this project${agentList(report)}${span(report)}.`,
      ...more,
    ];
  }
  const where = report.scope === 'project' ? ' of this project' : '';
  return [
    `Checked ${plural(s.total, 'session', 'sessions')}${where}${agentList(report)}${span(report)}.`,
  ];
}

function keyLines(report: SentReport): string[] {
  if (report.scope === 'audit-log') return [];
  const k = report.keys;
  const home = k.files.filter((f) => f.startsWith('~/.') && !/(^|\/)\.env[^/]*$/.test(f));
  const envFiles = k.files.filter((f) => !home.includes(f));
  const parts = [
    ...home,
    ...(envFiles.length > 2 ? [`${envFiles.length} .env files`] : envFiles),
    ...(k.env > 0 ? ['your shell environment'] : []),
  ].map(safe);
  const unread =
    k.unreadable > 0 ? ` ${plural(k.unreadable, 'key file', 'key files')} could not be read.` : '';
  return [
    `Compared with ${plural(k.compared, 'key', 'keys')}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.${unread}${leftOut(k)}`,
  ];
}

/** ` 3 key files were not read whole and 40 .env files were not read, so …`, or ''. */
function leftOut(k: SentReport['keys']): string {
  const partial = k.partial?.length ?? 0;
  const skipped = k.skippedFiles ?? 0;
  const parts = [
    ...(partial > 0 ? [`${plural(partial, 'key file was', 'key files were')} not read whole`] : []),
    ...(skipped > 0 ? [`${plural(skipped, '.env file was', '.env files were')} not read`] : []),
  ];
  if (parts.length > 0) return ` ${parts.join(' and ')}, so some keys were not compared.`;
  return k.truncated === true
    ? ' Some keys found were left out, so not every key was compared.'
    : '';
}

/** Paths of key files not read whole printed in "Not checked"; the rest are counted. */
const MAX_PARTIAL_SHOWN = 5;

/** What "Not checked" says of keys left out of the comparison, or nothing. */
function keysNotChecked(k: SentReport['keys']): string[] {
  const partial = k.partial ?? [];
  const shown = partial.slice(0, MAX_PARTIAL_SHOWN).map(safe);
  const more = partial.length - shown.length;
  const files =
    more > 0 ? `${shown.join(', ')} and ${plural(more, 'more', 'more')}` : shown.join(', ');
  return [
    ...(partial.length > 0
      ? [
          `keys in ${plural(partial.length, 'key file', 'key files')} Stroq did not read whole, too large or holding too many keys: ${files}`,
        ]
      : []),
    ...(k.skippedFiles === undefined
      ? []
      : [
          `the keys in ${plural(k.skippedFiles, '.env file', '.env files')} past the first ${MAX_FOLDER_ENV_FILES} of a folder, or its first ${MAX_FOLDER_BYTES / 1024 / 1024} MB`,
        ]),
    ...(k.truncated === true && partial.length === 0
      ? [`keys past the first ${MAX_KEYS} Stroq compares`]
      : []),
  ];
}

/** Routes whose `detail` is a file path, shown with `~` like every other path in the report. */
const PATH_ROUTES = new Set(['write', 'write-script', 'write-sent', 'write-push']);

/** The finding as it is shown: a file path in its place with the home written as `~`. */
function shown(f: Finding, home: string): Finding {
  const detail = f.place.detail;
  const isPath =
    PATH_ROUTES.has(f.place.route) ||
    (f.place.route === 'result' && (f.place.tool === 'Read' || f.place.tool === 'Grep'));
  if (detail === undefined || !isPath) return f;
  return { ...f, place: { ...f.place, detail: displayPath(detail, home) } };
}

function findingLines(raw: Finding, n: number, home: string): string[] {
  const f = shown(raw, home);
  const source = f.source === 'env' ? 'your shell environment' : safe(f.source);
  const where = [
    when(f.at),
    AGENTS[f.session.agent] ?? f.session.agent,
    ...(f.session.cwd === null ? [] : [safe(displayPath(f.session.cwd, home))]),
    ...(f.subagent === undefined ? [] : [`in subagent ${safe(f.subagent)}`]),
    ...(f.sessions > 1 ? [`seen in ${f.sessions} sessions`] : []),
  ];
  const decoy = f.canary === true ? ' (a canary you planted with `stroq canary`)' : '';
  // A canary found in a session by its hash was read from no file: it has no source to name.
  const from = f.canary === true && f.source === CANARY_SOURCE ? ' ' : `  from ${source}`;
  return [
    ` ${n}. ${safe(f.name)}${from}${decoy}`,
    `    ${(f.place.route === 'record' || f.place.route === 'cut' ? 'seen in' : LABEL[f.tier]).padEnd(8)} ${safe(describePlace(f.place))}`,
    `    when     ${where.join(' · ')}`,
    ...notRuledOut(f),
    `    do       ${safe(doLine(f))}`,
  ];
}

/** For a key the AI saw: the later calls that could have taken it out without showing it. */
function notRuledOut(f: Finding): string[] {
  const n = f.laterNetworkCommands ?? 0;
  if (f.tier !== 'seen' || n === 0) return [];
  const where =
    (f.laterNetworkSessions ?? 1) > 1 ? 'in the sessions it was seen in' : 'in that session';
  return [
    `    note     Not ruled out: ${plural(n, 'later command', 'later commands')} ${where} could reach the network.`,
  ];
}

function tierLines(report: SentReport, home: string): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const tier of TIERS) {
    const found = inTier(report, tier);
    if (found.length === 0) continue;
    lines.push(`${HEADINGS[tier]} (${found.length})`);
    for (const f of found.slice(0, MAX_SHOWN)) {
      n += 1;
      lines.push(...findingLines(f, n, home));
    }
    if (found.length > MAX_SHOWN) {
      n += found.length - MAX_SHOWN;
      lines.push(` … and ${found.length - MAX_SHOWN} more. \`stroq sent --json\` lists them all.`);
    }
    lines.push('');
  }
  return lines;
}

const CALL_ROUTES = new Set([
  'command',
  'command-near',
  'command-ran',
  'command-unread',
  'post',
  'secret-store',
  'ssh',
  'git-push',
  'publish',
  'web-fetch',
  'web-search',
  'mcp',
  'write-script',
  'write-sent',
]);

function notChecked(report: SentReport): string {
  const s = report.sessions;
  const parts = [
    ...(report.notChecked.includes('cursor')
      ? ['Cursor sessions (they need node:sqlite, in Node 22.23 or newer)']
      : []),
    ...(report.notChecked.includes('cursor-recent')
      ? [
          "Cursor's newest changes, still in its write-ahead file, which Stroq cannot read without writing beside Cursor's store (quit Cursor, then run this again)",
        ]
      : []),
    ...(report.unreadable > 0
      ? [
          plural(
            report.unreadable,
            'session file that could not be read',
            'session files that could not be read',
          ),
        ]
      : []),
    ...(report.searchCut === undefined
      ? []
      : [
          `the rest of ${plural(report.searchCut, 'session text', 'session texts')} whose search for keys was cut short by many keys that begin alike (possible tampering)`,
        ]),
    ...(report.workCut === undefined
      ? []
      : [
          report.workCut === 0
            ? 'commands past the time Stroq spends reading commands in one run, which were not read'
            : `${plural(report.workCut, 'command', 'commands')} not read, past the time Stroq spends reading commands in one run: each key they could carry is placed as maybe sent`,
        ]),
    ...(report.savedOutputsSkipped === undefined
      ? []
      : [
          `which call printed a key found in ${plural(report.savedOutputsSkipped, 'saved large output', 'saved large outputs')} read past the first ${SPILL_BUDGET_BYTES / 1024 / 1024} MB of them`,
        ]),
    ...(s.skipped === undefined
      ? []
      : [
          `${plural(s.skipped, 'session', 'sessions')} whose folder is not recorded, which --here cannot place`,
        ]),
    ...keysNotChecked(report.keys),
    ...(report.keys.rejectedLines === undefined
      ? []
      : [
          `${plural(report.keys.rejectedLines, 'line', 'lines')} named like a key whose value Stroq does not compare (too short, a placeholder, a path or an address)`,
        ]),
    ...(report.keys.subfolderEnvFiles === undefined
      ? []
      : [
          `${plural(report.keys.subfolderEnvFiles, 'env file', 'env files')} in a subfolder of a project (config/.env), not read`,
        ]),
    ...(report.keys.canariesNotFound === undefined
      ? []
      : [
          `${plural(report.keys.canariesNotFound, 'canary', 'canaries')} from \`stroq canary\` whose value is in no file Stroq reads`,
        ]),
    ...(report.keys.canaryCheckCut === undefined
      ? []
      : [
          `the rest of ${plural(report.keys.canaryCheckCut, 'session file', 'session files')}: canary check cut short by too many canary-shaped values (possible tampering)`,
        ]),
    ...(s.noFolder === undefined
      ? []
      : [
          `the .env files of ${plural(s.noFolder, 'session', 'sessions')} whose folder is not recorded`,
        ]),
    'a key split, encoded or rebuilt before it was sent (base64, reversed, in pieces), which a search for its value or its file cannot see',
    'keys in ~/.ssh, kube and gcloud config, and the keychain',
    'secrets kept in JSON, YAML or TOML files',
    'Copilot, Windsurf and Antigravity sessions',
    'Claude Code sessions older than its cleanupPeriodDays (30 days by default), which it deletes',
  ];
  return `Not checked: ${parts.join('; ')}.`;
}

export function formatSent(report: SentReport, home: string): string {
  const fromCalls = report.findings.some(
    (f) => f.tier !== 'seen' && CALL_ROUTES.has(f.place.route),
  );
  const lines = [
    'stroq sent: did your AI agent pass your keys on?',
    '',
    ...(report.synthetic === true
      ? [
          'This is a built-in sample. The key and the session are made up.',
          'Nothing on this machine was read.',
          '',
        ]
      : []),
    ...verdictLines(report),
    '',
    ...sessionLines(report),
    ...keyLines(report),
    '',
    ...tierLines(report, home),
    SEND_LIMIT,
    ...(fromCalls
      ? ['A key in a call was written by the AI, so your AI provider saw it too.']
      : []),
    ...(report.synthetic === true ? [] : [notChecked(report)]),
    report.synthetic === true
      ? 'Stroq read a made-up session here: this check sent nothing and wrote nothing. No key values are printed.'
      : 'This check only read files: it sent nothing and wrote nothing. No key values are printed.',
    ...(report.synthetic === true
      ? [
          '',
          'Next: `stroq sent` checks every session on this machine. `stroq init` guards the next one.',
        ]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}
