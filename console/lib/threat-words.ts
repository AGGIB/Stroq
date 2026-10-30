import type {
  Ecosystem,
  Severity,
  ThreatAgent,
  ThreatFeed,
  ThreatMatch,
  ThreatProblem,
} from './threat-feed';

/**
 * The threat feed in words. A match says what pwn.watch names that this project or machine has; it
 * never says the project is affected, since the versions pwn.watch gives are prose to check by hand.
 */

export const THREAT_FEED_KEY = 'stroq.console.threatFeed';

/** Whether the threat feed is on in this browser: it is off until you turn it on in Settings. */
export function threatFeedOn(): boolean {
  try {
    return window.localStorage.getItem(THREAT_FEED_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setThreatFeed(on: boolean): boolean {
  try {
    if (on) window.localStorage.setItem(THREAT_FEED_KEY, 'on');
    else window.localStorage.removeItem(THREAT_FEED_KEY);
    return true;
  } catch {
    return false;
  }
}

export const ECOSYSTEM_LABELS: Readonly<Record<Ecosystem, string>> = {
  npm: 'npm',
  pypi: 'PyPI',
  'github-actions': 'GitHub Actions',
  docker: 'Docker',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  wordpress: 'WordPress',
  java: 'Java',
  dotnet: '.NET',
};

export const AGENT_LABELS: Readonly<Record<ThreatAgent, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
};

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Severity not given',
};

const PROBLEMS: Readonly<Record<ThreatProblem, string>> = {
  network: 'pwn.watch could not be reached',
  timeout: 'pwn.watch took too long to answer',
  'too-large': 'the list was larger than expected',
  invalid: 'the list was not in the form expected',
};

const joined = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;

/** Why an incident is shown, in a sentence. */
export function whySentence(match: ThreatMatch): string {
  const { why } = match;
  if (why.kind === 'package')
    return `Names ${why.name}, which this project lists in ${why.ecosystem === 'npm' ? 'package.json' : 'its Python requirements'}. Check the version you have against pwn.watch.`;
  if (why.kind === 'agent')
    return `About ${AGENT_LABELS[why.agent]}, which is set up on this machine. Check the version you have against pwn.watch.`;
  const kind = match.live
    ? 'A supply-chain attack pwn.watch still follows'
    : 'A supply-chain attack updated in the last two weeks';
  return `${kind}, filed under ${ECOSYSTEM_LABELS[why.ecosystem]}, which this project uses. Check whether a package it names is one of yours.`;
}

const PATCHES: Readonly<Record<ThreatMatch['patch'], string | null>> = {
  patched: 'Fixed version out',
  partial: 'Partly fixed',
  unpatched: 'No fix yet',
  'no-fix-needed': 'No fix needed',
  unknown: null,
};

/** What pwn.watch says about a fix, in a few words, or null where it says nothing. */
export function patchLabel(match: ThreatMatch): string | null {
  return PATCHES[match.patch];
}

/** A time, with its day when it is not today: `15:05`, or `25 Oct, 15:05`. */
const clock = (at: string, now: Date): string => {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return today
    ? time
    : `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
};

/** What the matches were compared with, and when the list was downloaded, in a few sentences. */
export function comparedSentence(feed: ThreatFeed, now: Date = new Date()): string {
  const { compared } = feed;
  const uses = [
    ...(compared.packages > 0
      ? [
          `${compared.packages.toLocaleString('en-US')} ${compared.packages === 1 ? 'package' : 'packages'}`,
        ]
      : []),
    ...compared.ecosystems.map((ecosystem) => ECOSYSTEM_LABELS[ecosystem]),
  ];
  const withWhat = [
    ...(uses.length > 0 ? [`what this project uses (${uses.join(', ')})`] : []),
    ...(compared.agents.length > 0
      ? [
          `the agents set up on this machine (${compared.agents.map((agent) => AGENT_LABELS[agent]).join(', ')})`,
        ]
      : []),
  ];
  const sentences = [
    `Compared ${compared.incidents.toLocaleString('en-US')} incidents here${withWhat.length > 0 ? ` with ${withWhat.join(' and ')}` : ''}. Nothing about the project was sent.`,
  ];
  if (compared.skipped > 0)
    sentences.push(
      `${compared.skipped.toLocaleString('en-US')} of the list’s incidents could not be read, so they were not compared.`,
    );
  if (feed.fetchedAt !== null)
    sentences.push(
      feed.problem === null
        ? `The list as of ${clock(feed.fetchedAt, now)}.`
        : `The latest download failed (${PROBLEMS[feed.problem]}); this is the list as of ${clock(feed.fetchedAt, now)}.`,
    );
  if (compared.unread.length > 0)
    sentences.push(`Not compared: ${joined(compared.unread)}, which could not be read.`);
  return sentences.join(' ');
}

/** Why there is no list, in a sentence. */
export function unavailableSentence(problem: ThreatProblem | null): string {
  return `Could not get pwn.watch’s list: ${PROBLEMS[problem ?? 'network']}.`;
}
