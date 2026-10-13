// A card that says what `stroq sent` found without saying anything that was found.
//
// `stroq sent` names the credentials a session carried and the calls that carried them, which is
// the point of the report and the reason it cannot be pasted into a post. The card is the part
// that can be: counts, the providers the credentials belong to, and what the check could and could
// not see. It is built from the report by taking numbers and by choosing labels out of tables in
// this file. Nothing the report holds as text (a credential's name, a path, a command, the session's
// id, a hash) is copied into it, so there is nothing for an escape to miss: the only strings that
// are not constants here are numbers.
import type { SentReport } from './report.js';

/** The providers a credential can be filed under. The labels are ours; a credential's own name is never used. */
const PROVIDERS: readonly (readonly [RegExp, string])[] = [
  [/aws|amazon|boto|(?:^|[_-])s3(?:[_-]|$)/i, 'AWS'],
  [/github|(?:^|[_-])gh[_-]|ghp_|ghs_/i, 'GitHub'],
  [/gitlab/i, 'GitLab'],
  [/openai/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic'],
  [/stripe/i, 'Stripe'],
  [/google|gcp|gcloud|firebase|gemini/i, 'Google'],
  [/azure/i, 'Azure'],
  [/(?:^|[_-])npm(?:[_-]|$)/i, 'npm'],
  [/docker/i, 'Docker'],
  [/slack/i, 'Slack'],
  [/twilio|sendgrid/i, 'Twilio'],
  [/supabase/i, 'Supabase'],
  [/vercel|netlify|cloudflare|heroku|digitalocean/i, 'Hosting'],
  [/sentry|datadog|newrelic/i, 'Monitoring'],
  [/postgres|mysql|mongo|redis|database|(?:^|[_-])db[_-]/i, 'Database'],
  [/ssh|private[_-]?key|\.pem|rsa|ed25519/i, 'SSH or a private key'],
];
const OTHER_PROVIDER = 'Other';
const CANARY_PROVIDER = 'Canary';

/** The agents a card can name, by the label a reader gives them. */
const AGENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot CLI',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  openclaw: 'OpenClaw',
};

export interface SentCardProvider {
  /** A label from the table above: never taken from the credential. */
  readonly label: string;
  readonly count: number;
}

/** Everything a card says. Numbers, and labels chosen from constants. */
export interface SentCard {
  readonly version: 1;
  /** The agent whose record was read, as a label from `AGENTS`, or null. */
  readonly agent: string | null;
  readonly stroq: string;
  /** The day the check was made, `YYYY-MM-DD`. */
  readonly checked: string;
  /** Distinct credentials the record carried, and every sighting of them. */
  readonly credentials: number;
  readonly sightings: number;
  readonly providers: readonly SentCardProvider[];
  /** Credential files a read or a command touched, not their paths. */
  readonly files: number;
  readonly calls: number;
  readonly results: number;
  readonly toolResultsRead: boolean;
  /** Credentials this machine holds that the record was checked against. */
  readonly indexed: number;
  readonly sessionsInProject: number | null;
  readonly fromAuditLog: boolean;
}

/** Which provider a credential belongs to, by its name and where it was read from. */
export function providerOf(name: string, source: string, canary: boolean): string {
  if (canary) return CANARY_PROVIDER;
  const text = `${name} ${source}`;
  for (const [pattern, label] of PROVIDERS) if (pattern.test(text)) return label;
  return OTHER_PROVIDER;
}

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The card for a report. Nothing is copied from it but counts. */
export function buildCard(report: SentReport, stroq: string, now: Date = new Date()): SentCard {
  const byProvider = new Map<string, number>();
  for (const credential of report.credentials) {
    const label = providerOf(credential.name, credential.source, credential.canary);
    byProvider.set(label, (byProvider.get(label) ?? 0) + 1);
  }
  const providers = [...byProvider.entries()]
    .map(([label, n]) => ({ label, count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    version: 1,
    agent: report.agent !== null ? (AGENTS[report.agent] ?? null) : null,
    stroq: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(stroq) ? stroq : 'unknown',
    checked: now.toISOString().slice(0, 10),
    credentials: report.credentials.length,
    sightings: report.credentials.reduce((sum, c) => sum + count(c.count), 0),
    providers,
    files: report.files.length,
    calls: count(report.coverage.calls),
    results: count(report.coverage.results),
    toolResultsRead: report.coverage.toolResultsRead,
    indexed: count(report.coverage.indexedSecrets),
    sessionsInProject: report.coverage.sessionsInProject ?? null,
    fromAuditLog: report.origin === 'audit-log',
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `AWS 1 · GitHub 2`: the providers, most first. */
function providerList(card: SentCard): string {
  return card.providers.map((p) => `${p.label} ${p.count}`).join(' · ');
}

/** The headline: what the record holds, in a sentence that claims no more than a record does. */
export function headline(card: SentCard): string {
  if (card.indexed === 0)
    return 'Nothing to check against: Stroq found no credential files or project .env files on this machine.';
  if (card.credentials === 0)
    return `No credential from this machine appears in the record of the session (checked against ${plural(card.indexed, 'value', 'values')}).`;
  return `The record of the session holds ${plural(card.credentials, 'credential', 'credentials')} from this machine.`;
}

/** A line for a post. It says what was checked and how, and holds no value. */
export function postLine(card: SentCard): string {
  const subject = card.agent ?? 'my AI coding agent';
  if (card.credentials === 0)
    return `Checked ${subject}'s last session against ${plural(card.indexed, 'credential', 'credentials')} on my machine: none of them appears in its record of ${plural(card.calls, 'tool call', 'tool calls')}. Done locally with \`npx @stroq/cli sent --last\`.`;
  return `${subject}'s last session carried ${plural(card.credentials, 'credential', 'credentials')} from my machine (${providerList(card)}) in ${plural(card.calls, 'tool call', 'tool calls')}. Checked locally with \`npx @stroq/cli sent --last\`.`;
}

const LIMITS =
  'A credential in the record shows that its value appeared in a local transcript. It does not show a later request to a model provider, or delivery. A value that was rotated or deleted since the session is not in the index, so it cannot be found.';

/** The card as Markdown. */
export function cardMarkdown(card: SentCard): string {
  const rows: [string, string][] = [
    [
      'Credentials in the record',
      card.credentials === 0
        ? '0'
        : `${card.credentials} (${plural(card.sightings, 'sighting', 'sightings')})`,
    ],
    ['Tool calls read', String(card.calls)],
    [
      'Tool results read',
      card.toolResultsRead ? String(card.results) : 'none (an audit log holds no results)',
    ],
    ['Credential files touched', String(card.files)],
    ['Checked against', plural(card.indexed, 'value', 'values')],
  ];
  if (card.agent !== null) rows.push(['Agent', card.agent]);
  if (card.sessionsInProject !== null)
    rows.push(['Sessions in this project', String(card.sessionsInProject)]);
  const lines = [
    '# Stroq session check',
    '',
    `**${headline(card)}**`,
    ...(card.providers.length > 0 ? ['', providerList(card)] : []),
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    '',
    LIMITS,
    '',
    `Checked on ${card.checked} with Stroq ${card.stroq}. The check ran on this machine, and this card holds counts only: no values, names, paths, commands or hashes.`,
    '',
    `> ${postLine(card)}`,
  ];
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------------------------------------
// HTML
// -------------------------------------------------------------------------------------------

/** Escapes text for HTML. Every string that is not a constant goes through it, though none is free text. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE = `
:root{--paper:#f4f1ea;--ink:#16140f;--mute:#6b665b;--rule:#d9d3c4;--hot:#d2420f;--ok:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--paper:#14120e;--ink:#f1ede2;--mute:#9a947f;--rule:#2e2a21;--hot:#ff6a3a;--ok:#7fc58b}}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;padding:clamp(20px,5vw,56px);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto}
.kicker{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.big{margin:20px 0 4px;font:700 clamp(72px,22vw,148px)/.9 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.04em}
.big.hot{color:var(--hot)}.big.ok{color:var(--ok)}
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
  const tone = card.indexed === 0 ? '' : card.credentials === 0 ? 'ok' : 'hot';
  const rows: [string, string][] = [
    [
      'Credentials in the record',
      card.credentials === 0 ? '0' : `${card.credentials} · ${card.sightings} sightings`,
    ],
    ['Tool calls read', String(card.calls)],
    ['Tool results read', card.toolResultsRead ? String(card.results) : 'none'],
    ['Credential files touched', String(card.files)],
    ['Checked against', plural(card.indexed, 'value', 'values')],
  ];
  if (card.agent !== null) rows.push(['Agent', card.agent]);
  if (card.sessionsInProject !== null)
    rows.push(['Sessions in this project', String(card.sessionsInProject)]);
  const list =
    card.providers.length === 0
      ? ''
      : `<ul class="providers" aria-label="Providers">${card.providers
          .map((p) => `<li>${escapeHtml(p.label)} <b>${p.count}</b></li>`)
          .join('')}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>Stroq session check</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="kicker">Stroq session check</div>
<div class="big ${tone}" aria-hidden="true">${card.credentials}</div>
<h1>${escapeHtml(headline(card))}</h1>
${list}
<dl>${rows
    .map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('')}</dl>
<p class="limits">${escapeHtml(LIMITS)}</p>
<p class="post">${escapeHtml(postLine(card).replace(/`/g, ''))}</p>
<footer>Checked on ${escapeHtml(card.checked)} with Stroq ${escapeHtml(card.stroq)}. The check ran on this machine; this card holds counts only, no values, names, paths, commands or hashes.</footer>
</main>
</body>
</html>
`;
}
