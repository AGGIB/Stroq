// A card that says what `stroq sent` found without saying anything that was found.
//
// The report names keys, files, hosts and folders, which is the point of it and the reason it
// cannot be pasted into a post. The card can be: it is built from `--counts` (`counts.ts`),
// which holds only numbers, dates and labels chosen from tables in the code. Every string in it
// that is not a constant here is a number or a date.
import type { SentCounts } from './counts.js';
import { countParts, SEND_LIMIT } from './phrases.js';
import { TIERS, type Tier } from './place.js';

/** The agents a card can name, by fixed label. */
const AGENT_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

const TIER_LABELS: Readonly<Record<Tier, string>> = {
  third_party: 'Sent to another company',
  maybe: 'Maybe sent',
  seen: 'Seen by the AI',
  own_service: 'Used with its own service',
  blocked: 'Blocked before it ran',
};

export interface SentCardProvider {
  readonly label: string;
  readonly count: number;
}

/** Everything a card says. Numbers, dates, and labels chosen from constants. */
export interface SentCard {
  readonly version: 2;
  /** True only for the built-in sample, whose counts describe a made-up key. */
  readonly synthetic?: true;
  readonly stroq: string;
  readonly checked: string;
  readonly sessions: number;
  readonly agents: readonly string[];
  readonly keys: number;
  readonly found: Readonly<Record<Tier, number>>;
  readonly providers: readonly SentCardProvider[];
  /** Nothing in the run was left unchecked (`--counts`' `complete`). */
  readonly complete: boolean;
  /** Session and key files that could not be read. */
  readonly filesNotRead: number;
}

export function buildCard(counts: SentCounts): SentCard {
  const sessions = Object.values(counts.agents).reduce(
    (sum, a) => sum + ('sessions' in a ? a.sessions : 0),
    0,
  );
  const agents = Object.entries(counts.agents)
    .filter(([, a]) => 'sessions' in a && a.sessions > 0)
    .map(([agent]) => AGENT_LABELS[agent] ?? 'Other');
  const providers = Object.entries(counts.providers)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    version: 2,
    ...(counts.synthetic === true ? { synthetic: true as const } : {}),
    stroq: counts.version,
    checked: counts.checked,
    sessions,
    agents,
    keys: counts.keys_compared,
    found: Object.fromEntries(TIERS.map((t) => [t, counts.found[t]])) as Record<Tier, number>,
    providers,
    complete: counts.complete,
    filesNotRead: counts.unreadable_files,
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const total = (card: SentCard): number => TIERS.reduce((sum, t) => sum + card.found[t], 0);

/**
 * The headline: what was found, as counts. It never says a key did not go somewhere, and it says
 * no value appears only for a check that read sessions and left nothing unchecked.
 */
export function headline(card: SentCard): string {
  if (card.synthetic === true)
    return 'The built-in sample holds 1 made-up key. Nothing on this machine was read.';
  if (card.keys === 0) return 'Nothing to check against: Stroq found no keys on this machine.';
  if (card.sessions === 0) return 'No sessions were read.';
  const n = total(card);
  if (n === 0 && !card.complete) return 'Incomplete: see the full report.';
  if (n === 0)
    return `None of ${plural(card.keys, "key's value", "keys' values")} from this machine appear in these AI agent sessions.`;
  return `${n} of ${plural(card.keys, 'key', 'keys')} from this machine ${n === 1 ? 'appears' : 'appear'} in AI agent sessions: ${countParts(card.found).join(', ')}.`;
}

/** What the check read, and what it did not. */
export function coverageLine(card: SentCard): string {
  const read = `${plural(card.sessions, 'session', 'sessions')} read, ${plural(card.filesNotRead, 'file', 'files')} not read`;
  return card.complete
    ? `Coverage: ${read}.`
    : `Coverage: ${read}, and more not checked: see the full report.`;
}

/** A line for a post. It says what was checked and how, and holds no key. */
export function postLine(card: SentCard): string {
  if (card.synthetic === true)
    return "Tried Stroq's built-in sample with a made-up key. Run it with `npx @stroq/cli sent --try`.";
  if (card.sessions === 0)
    return 'Ran a key check on my machine with `npx @stroq/cli sent`: it found no AI agent sessions to read.';
  const n = total(card);
  const found =
    n > 0
      ? [`${n} appear`, ...countParts(card.found)].join(', ')
      : card.complete
        ? 'none of their values appear'
        : 'the check was incomplete';
  return `Checked ${plural(card.sessions, 'AI agent session', 'AI agent sessions')} on my machine against ${plural(card.keys, 'key', 'keys')}: ${found}. Done locally with \`npx @stroq/cli sent\`.`;
}

const LIMITS = `A key counts as sent when a recorded call carried it to a host. The record does not show what the host kept. ${SEND_LIMIT} A key rotated or deleted since the session is not compared.`;
const SAMPLE_LIMITS =
  'This is a built-in sample with a made-up key. No file on this machine was read.';

function rows(card: SentCard): [string, string][] {
  return [
    ['Sessions read', String(card.sessions)],
    ['Keys compared', String(card.keys)],
    ...TIERS.map((t): [string, string] => [TIER_LABELS[t], String(card.found[t])]),
    ...(card.agents.length > 0 ? [['Agents', card.agents.join(', ')] as [string, string]] : []),
  ];
}

const footer = (card: SentCard): string =>
  `Checked on ${card.checked} with Stroq ${card.stroq}. The check ran on this machine. This card holds counts only: no keys, names, paths, hosts, commands or hashes.`;

const providerList = (card: SentCard): string =>
  card.providers.map((p) => `${p.label} ${p.count}`).join(' · ');

/** The card as Markdown. */
export function cardMarkdown(card: SentCard): string {
  const lines = [
    '# Stroq key check',
    '',
    `**${headline(card)}**`,
    ...(card.providers.length > 0 ? ['', providerList(card)] : []),
    '',
    '| | |',
    '|---|---|',
    ...rows(card).map(([name, value]) => `| ${name} | ${value} |`),
    '',
    ...(card.synthetic === true ? [] : [coverageLine(card), '']),
    card.synthetic === true ? SAMPLE_LIMITS : LIMITS,
    '',
    footer(card),
    '',
    `> ${postLine(card)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Escapes text for HTML. Every string that is not a constant goes through it, though none is free text. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE = `
:root{--paper:#f4f1ea;--ink:#16140f;--mute:#6b665b;--rule:#d9d3c4;--hot:#d2420f}
@media (prefers-color-scheme:dark){:root{--paper:#14120e;--ink:#f1ede2;--mute:#9a947f;--rule:#2e2a21;--hot:#ff6a3a}}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;padding:clamp(20px,5vw,56px);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto}
.kicker{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.big{margin:20px 0 4px;font:700 clamp(72px,22vw,148px)/.9 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.04em}
.big.hot{color:var(--hot)}
.big-label{margin:0 0 12px;font:600 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hot)}
h1{margin:0;font-size:clamp(20px,4.6vw,26px);line-height:1.25;font-weight:650}
.providers{margin:14px 0 0;display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}
.providers li{border:1px solid var(--ink);padding:3px 10px;font:600 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.providers b{color:var(--hot)}
dl{margin:32px 0 0;border-top:2px solid var(--ink)}
dl div{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--rule)}
dt{color:var(--mute)}dd{margin:0;font:600 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}
p{margin:24px 0 0}.limits{color:var(--mute);font-size:14px}
.post{margin-top:28px;padding:14px 16px;border-left:4px solid var(--hot);background:color-mix(in srgb,var(--ink) 5%,transparent);font-size:15px}
footer{margin-top:32px;color:var(--mute);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
`;

/** The card as one HTML file: no script, no external resource, a policy that allows neither. */
export function cardHtml(card: SentCard): string {
  const sent = card.found.third_party;
  // A number only with what it counts, and only when there is one to count: no "0" says "safe".
  const big =
    sent > 0
      ? `<div class="big hot" aria-hidden="true">${sent}</div>\n<div class="big-label">sent to another company</div>\n`
      : '';
  const coverage =
    card.synthetic === true ? '' : `<p class="coverage">${escapeHtml(coverageLine(card))}</p>\n`;
  const list =
    card.providers.length === 0
      ? ''
      : `<ul class="providers" aria-label="Services">${card.providers
          .map((p) => `<li>${escapeHtml(p.label)} <b>${p.count}</b></li>`)
          .join('')}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>Stroq key check</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="kicker">Stroq key check</div>
${big}<h1>${escapeHtml(headline(card))}</h1>
${list}
<dl>${rows(card)
    .map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('')}</dl>
${coverage}<p class="limits">${escapeHtml(card.synthetic === true ? SAMPLE_LIMITS : LIMITS)}</p>
<p class="post">${escapeHtml(postLine(card).replace(/`/g, ''))}</p>
<footer>${escapeHtml(footer(card))}</footer>
</main>
</body>
</html>
`;
}
