// `stroq replay --html`: the same history as the terminal view, as one file you can open.
//
// What it shows is what the terminal view shows (content the agent read, what came out of it, what
// the policy says of each action) with the chain drawn: read, then what the scan made of it, then the
// action it led to, then what the policy made of that. A replay of a recording says WOULD DENY in
// dashed outline; what was recorded while Stroq ran says DENIED in a solid one. They are different
// claims and look different.
//
// THE DATA IS HOSTILE. Every command, path, URL and excerpt in a session came from content an
// attacker may have written, and this file is opened in a browser by the person who is looking for
// what the attacker did. So: control and direction characters are written out as visible escapes (the
// same `neutralizeControls` the terminal view uses), every piece of text is escaped for HTML, there is
// no script and no link and no external resource in the file, and a Content-Security-Policy that
// allows none of them is the last line if all of that is wrong.
import { ageLabel, type AuditEntry } from '@stroq/core';
import type {
  ReplayConsequence,
  ReplayModel,
  ReplaySource,
  ReplayVoice,
} from '../commands/replay.js';
import { neutralizeControls } from '../terminal-safe.js';

/** The most of each part a file shows; the rest is counted, so that a huge session is still a file a browser opens. */
export const MAX_SOURCES = 300;
export const MAX_CONSEQUENCES = 40;
export const MAX_SECRET_ACTIONS = 200;
export const MAX_UNLINKED = 200;
/** The longest text a line shows before it is cut. */
const CLIP = 400;

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'";

/** Escapes text for HTML. Never used on a string that has not been through `safe` first. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Characters that show nothing, or change what is shown, and that `neutralizeControls` leaves to the
 * terminal: zero-width and formatting characters, line and paragraph separators, variation selectors,
 * and the tag characters that smuggle text past a reader. In a page that exists to show what was
 * written, each is written out as the visible escape it is.
 */
const INVISIBLE =
  /[\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\u206a-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

function showInvisible(text: string): string {
  return text.replace(INVISIBLE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** Text that came from a session, as it may be written into the page: cut, with controls made visible, escaped. */
export function safe(text: string, limit = CLIP): string {
  const cut = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return escapeHtml(showInvisible(neutralizeControls(cut)));
}

type Effect = 'deny' | 'ask' | 'allow' | 'none';

interface Verdict {
  readonly effect: Effect;
  /** `DENIED`, `WOULD DENY`, `asked`, `would allow`: the voice of the replay. */
  readonly label: string;
  readonly rule: string;
}

function verdictOf(entry: AuditEntry, voice: ReplayVoice): Verdict {
  const d = entry.decision;
  if (d === undefined) return { effect: 'none', label: 'no verdict', rule: '' };
  const rule = d.ruleId ?? 'default';
  const labels: Readonly<Record<'deny' | 'ask' | 'allow', readonly [string, string]>> = {
    deny: ['DENIED', 'WOULD DENY'],
    ask: ['ASKED', 'WOULD ASK'],
    allow: ['allowed', 'would allow'],
  };
  const effect: 'deny' | 'ask' | 'allow' =
    d.effect === 'deny' ? 'deny' : d.effect === 'ask' ? 'ask' : 'allow';
  const [recorded, replayed] = labels[effect];
  return { effect, label: voice === 'replayed' ? replayed : recorded, rule };
}

function pill(verdict: Verdict, voice: ReplayVoice): string {
  const klass = `pill ${verdict.effect}${voice === 'replayed' ? ' replayed' : ''}`;
  const rule = verdict.rule === '' ? '' : ` <span class="rule">${safe(verdict.rule, 80)}</span>`;
  return `<span class="${klass}">${safe(verdict.label, 24)}</span>${rule}`;
}

/** What the scan made of a read: a clean verdict says so plainly, and says tool output is data. */
function scanPill(source: ReplaySource): string {
  const scan = source.read?.scan;
  if (scan === undefined)
    return source.suspect
      ? '<span class="pill suspect">flagged suspicious</span>'
      : '<span class="pill clean">no rule matched</span>';
  if (scan.verdict !== 'suspect') return '<span class="pill clean">clean</span>';
  const waived = scan.trusted === true ? ' · waived by stroq trust' : '';
  const ids = scan.ruleIds.slice(0, 3).map((id) => safe(id, 40));
  const more = scan.ruleIds.length > 3 ? ` +${scan.ruleIds.length - 3}` : '';
  return (
    `<span class="pill suspect">suspect ${scan.score.toFixed(2)}${safe(waived, 40)}</span> ` +
    `<span class="rule">${scan.ruleIds.length} ${scan.ruleIds.length === 1 ? 'rule' : 'rules'}: ${ids.join(', ')}${more}</span>`
  );
}

const ARROW =
  '<svg class="arrow" viewBox="0 0 44 14" width="44" height="14" aria-hidden="true" focusable="false"><path d="M1 7H38M31 1.5l7 5.5-7 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function consequenceRow(c: ReplayConsequence, voice: ReplayVoice): string {
  const verdict = verdictOf(c.action, voice);
  const gap = ageLabel(c.evidence.at, new Date(c.action.ts));
  const more = c.alsoCarried > 0 ? ` and ${c.alsoCarried} more` : '';
  return `<li class="act ${verdict.effect}">
${ARROW}
<div class="body">
<div class="line"><span class="seq">#${c.action.seq}</span> <span class="tool">${safe(c.action.tool, 60)}</span> ${pill(verdict, voice)} <span class="gap">${safe(gap, 24)} later</span></div>
<code class="cmd">${safe(c.action.summary)}</code>
<div class="carried">carried over: <q>${safe(c.evidence.excerpt, 160)}</q> (${safe(c.evidence.kind, 24)})${more}</div>
</div>
</li>`;
}

function chain(source: ReplaySource, voice: ReplayVoice): string {
  const seq = source.read === null ? '' : `<span class="seq">#${source.read.seq}</span> `;
  const shown = source.consequences.slice(0, MAX_CONSEQUENCES);
  const hidden = source.consequences.length - shown.length;
  const body =
    source.consequences.length === 0
      ? '<p class="none">nothing traced back to it</p>'
      : `<ul class="acts">${shown.map((c) => consequenceRow(c, voice)).join('\n')}${
          hidden > 0
            ? `<li class="more">and ${hidden} more actions that traced back to it</li>`
            : ''
        }</ul>`;
  return `<article class="chain${source.suspect ? ' hot' : ''}">
<header>
<div class="read"><span class="step">read</span> ${seq}<span class="tool">${safe(source.tool, 60)}</span></div>
<code class="cmd">${safe(source.source)}</code>
<div class="scan"><span class="step">scan</span> ${scanPill(source)}</div>
</header>
${body}
</article>`;
}

function plainAction(entry: AuditEntry, voice: ReplayVoice, extra = ''): string {
  const verdict = verdictOf(entry, voice);
  return `<li class="act ${verdict.effect}">
<div class="body">
<div class="line"><span class="seq">#${entry.seq}</span> <span class="tool">${safe(entry.tool, 60)}</span> ${pill(verdict, voice)}</div>
<code class="cmd">${safe(entry.summary)}</code>${extra}
</div>
</li>`;
}

function secretSection(model: ReplayModel, voice: ReplayVoice): string {
  if (model.secretActions.length === 0) return '';
  const shown = model.secretActions.slice(0, MAX_SECRET_ACTIONS);
  const items = shown.map((a) => {
    const names = (a.secrets ?? [])
      .map(
        (s) =>
          `<div class="secret">${safe(s.name, 80)} from ${safe(s.source, 120)}${s.canary ? ' (canary)' : ''}</div>`,
      )
      .join('');
    return plainAction(a, voice, names);
  });
  const hidden = model.secretActions.length - shown.length;
  return `<section>
<h2>Actions carrying a known secret value</h2>
<ul class="acts">${items.join('\n')}${hidden > 0 ? `<li class="more">and ${hidden} more</li>` : ''}</ul>
</section>`;
}

function unlinkedSection(model: ReplayModel, voice: ReplayVoice): string {
  if (model.unlinked.length === 0) return '';
  const shown = model.unlinked.slice(0, MAX_UNLINKED);
  const hidden = model.unlinked.length - shown.length;
  return `<section>
<h2>Actions with no untrusted origin <span class="count">${model.unlinked.length}</span></h2>
<ul class="acts quiet">${shown.map((a) => plainAction(a, voice)).join('\n')}${
    hidden > 0 ? `<li class="more">and ${hidden} more</li>` : ''
  }</ul>
</section>`;
}

interface FlowBox {
  readonly label: string;
  readonly n: number;
  readonly sub: string;
  readonly hot: boolean;
}

/** The chain as a picture: what was read, what traced back, what the policy said of the actions. */
function flow(model: ReplayModel, voice: ReplayVoice, traced: number, judged: number): string {
  const suspect = model.sources.filter((s) => s.suspect).length;
  const allowed = Math.max(0, judged - model.denied - model.asked);
  const would = voice === 'replayed';
  const deniedLabel = would ? 'would deny' : 'denied';
  const askedLabel = would ? 'would ask' : 'asked';
  const allowedLabel = would ? 'would allow' : 'allowed';
  const summary = `${model.sources.length} contents read, ${suspect} flagged suspect; ${traced} of ${judged} actions traced back to them; ${model.denied} ${deniedLabel}, ${model.asked} ${askedLabel}, ${allowed} ${allowedLabel}.`;
  const boxes: readonly FlowBox[] = [
    { label: 'READ', n: model.sources.length, sub: `${suspect} flagged suspect`, hot: suspect > 0 },
    { label: 'TRACED BACK', n: traced, sub: `of ${judged} judged actions`, hot: traced > 0 },
    {
      label: would ? "TODAY'S POLICY" : 'POLICY',
      n: model.denied + model.asked,
      sub: `${model.denied} deny · ${model.asked} ask`,
      hot: model.denied > 0,
    },
    { label: 'THROUGH', n: allowed, sub: allowedLabel, hot: false },
  ];
  const box = (b: FlowBox, x: number, y: number, width: number): string =>
    `<g transform="translate(${x} ${y})"><rect width="${width}" height="84" rx="4" class="nodebox${b.hot ? ' hot' : ''}"/><text x="14" y="25" class="nlabel">${escapeHtml(b.label)}</text><text x="14" y="60" class="nnum">${b.n}</text><text x="14" y="76" class="nsub">${escapeHtml(b.sub)}</text></g>`;
  // Wide: four boxes 168 wide and 40 apart, an arrow in each gap. Tall: the same four, one under another.
  const wide = boxes
    .map(
      (b, i) =>
        box(b, i * 208, 14, 168) +
        (i < 3
          ? `<path d="M${i * 208 + 172} 56H${i * 208 + 202}M${i * 208 + 195} 50l7 6-7 6" class="link"/>`
          : ''),
    )
    .join('\n');
  const tall = boxes
    .map(
      (b, i) =>
        box(b, 0, i * 112 + 4, 320) +
        (i < 3
          ? `<path d="M160 ${i * 112 + 92}V${i * 112 + 112}M154 ${i * 112 + 105}l6 7 6-7" class="link"/>`
          : ''),
    )
    .join('\n');
  return `<svg class="flow wide" viewBox="0 0 792 112" role="img" aria-label="${escapeHtml(summary)}">
<title>${escapeHtml(summary)}</title>
${wide}
</svg>
<svg class="flow tall" viewBox="0 0 320 448" role="img" aria-label="${escapeHtml(summary)}">
<title>${escapeHtml(summary)}</title>
${tall}
</svg>`;
}

const STYLE = `
:root{--paper:#f6f3ec;--card:#fffdf8;--ink:#17150f;--mute:#6a6558;--rule:#dcd5c5;--deny:#b3261e;--ask:#a15c00;--ok:#2e6b3a;--hot:#d2420f}
@media (prefers-color-scheme:dark){:root{--paper:#13110d;--card:#1b1812;--ink:#f1ede2;--mute:#9b9580;--rule:#322d22;--deny:#ff7b72;--ask:#f2b24c;--ok:#7fc58b;--hot:#ff6a3a}}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;padding:clamp(16px,4vw,48px);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto}
.kicker,.step,.seq,.rule,.count{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.kicker{letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
h1{margin:6px 0 4px;font-size:clamp(22px,4.4vw,32px);line-height:1.15}
h2{margin:40px 0 12px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;border-top:2px solid var(--ink);padding-top:10px}
.meta{color:var(--mute)}
.voice{margin:16px 0 0;padding:10px 14px;border-left:4px solid var(--ask);background:color-mix(in srgb,var(--ink) 5%,transparent)}
.flow{display:block;width:100%;height:auto;margin:24px 0 0}
.flow.tall{display:none;max-width:360px}
@media (max-width:640px){.flow.wide{display:none}.flow.tall{display:block}}
.nodebox{fill:var(--card);stroke:var(--ink);stroke-width:1.4}.nodebox.hot{stroke:var(--hot);stroke-width:2.4}
.nlabel{font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;fill:var(--mute)}
.nnum{font:700 34px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--ink)}
.nsub{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--mute)}
.link{fill:none;stroke:var(--ink);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.chain{margin:18px 0 0;padding:14px 16px;background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--rule)}
.chain.hot{border-left-color:var(--hot)}
.chain header{display:grid;gap:6px}
.step{display:inline-block;min-width:44px;padding:1px 6px;margin-right:6px;border:1px solid var(--mute);color:var(--mute);text-transform:uppercase;letter-spacing:.08em}
.tool{font-weight:650}
.cmd{display:block;padding:6px 8px;background:color-mix(in srgb,var(--ink) 6%,transparent);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
.acts{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:10px}
.act{display:flex;gap:10px;align-items:flex-start;padding:10px 0 0;border-top:1px dashed var(--rule)}
.arrow{flex:none;margin-top:6px;color:var(--mute)}
.act .body{flex:1;min-width:0;display:grid;gap:6px}
.line{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.gap{color:var(--mute);font-size:13px}
.carried{color:var(--mute);font-size:13px;overflow-wrap:anywhere}
q{quotes:none}q::before{content:"\\201C"}q::after{content:"\\201D"}
.pill{display:inline-block;padding:1px 8px;border:1.5px solid currentColor;font:700 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.pill.deny{color:var(--deny);background:color-mix(in srgb,var(--deny) 12%,transparent)}
.pill.ask{color:var(--ask);background:color-mix(in srgb,var(--ask) 12%,transparent)}
.pill.allow,.pill.clean{color:var(--ok)}
.pill.suspect{color:var(--hot);background:color-mix(in srgb,var(--hot) 12%,transparent)}
.pill.none{color:var(--mute)}
.pill.replayed{border-style:dashed;background:transparent}
.rule{color:var(--mute)}
.secret{color:var(--hot);font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.none,.more{margin:10px 0 0;color:var(--mute)}
.quiet .cmd{background:transparent;padding:0}
footer{margin-top:44px;color:var(--mute);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
`;

/** The model as one HTML file. */
export function formatReplayHtml(
  model: ReplayModel,
  voice: ReplayVoice = 'recorded',
  now: Date = new Date(),
): string {
  const traced = new Set(model.sources.flatMap((s) => s.consequences.map((c) => c.action.seq)))
    .size;
  const judged = traced + model.secretActions.length + model.unlinked.length;
  const duration =
    model.first !== null && model.last !== null
      ? ` · ${ageLabel(model.first, new Date(model.last))} long`
      : '';
  const counts =
    voice === 'replayed'
      ? `${model.denied} would be denied · ${model.asked} would ask (today's policy)`
      : `${model.denied} denied · ${model.asked} asked`;
  const sources = model.sources.slice(0, MAX_SOURCES);
  const hiddenSources = model.sources.length - sources.length;
  const verdict =
    traced === 0
      ? 'No action in this session traced back to content the agent read.'
      : `${traced} of ${judged} judged actions traced back to content the agent read.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>stroq replay</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="kicker">stroq replay</div>
<h1>What the agent did, and what told it to do it</h1>
<div class="meta">session <code>${safe(model.sessionId, 80)}</code> · ${model.total} events${safe(duration, 40)} · ${safe(counts, 100)}</div>
${
  voice === 'replayed'
    ? `<p class="voice">These are the verdicts today's policy gives the recording, in dashed outline: not a record of what was blocked at the time. Nothing here was stopped unless Stroq was running then.</p>`
    : ''
}
${flow(model, voice, traced, judged)}
${
  sources.length > 0
    ? `<section>
<h2>Content the agent read, and what came out of it</h2>
${sources.map((s) => chain(s, voice)).join('\n')}${
        hiddenSources > 0 ? `<p class="more">and ${hiddenSources} more reads</p>` : ''
      }
</section>`
    : ''
}
${secretSection(model, voice)}
${unlinkedSection(model, voice)}
<p><strong>${escapeHtml(verdict)}</strong></p>
<footer>Made by stroq replay on ${escapeHtml(now.toISOString().slice(0, 10))}. One file: no script, no link and no external resource, and a policy that allows none. Every command and path in it was written by something the agent read or the agent itself; control and direction characters are shown as escapes.</footer>
</main>
</body>
</html>
`;
}
