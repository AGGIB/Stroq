// The words of `stroq prove`: plain English, plain ASCII, nothing a terminal would obey.
//
// One table of the probes with a mark and a short reason, a verdict, and at most three lines of advice.
// The verdict says what it shows and what it does not, in the same words every time: that the hook line
// `stroq init` writes, run by this host version, stopped a command the policy denies and that the same
// command runs when the hook is out of the way; and not that the user's own settings file is loaded, nor
// that other versions or other hosts behave the same.
//
// Everything that is not ours (an agent name from the command line, the version a host printed, a caveat,
// a detail) goes through `outsideLine` before it is put on a line.
import { outsideLine, wrapKeeping } from '../ui/layout.js';
import type { ProbeResult } from '../live/types.js';
import { isControlId, CONTROL_SUFFIX } from '../live/state-rule.js';
import type { ProveReport } from './prove-report.js';

const WIDTH = 78;
const NAME_WIDTH = 38;
const MARK_WIDTH = 15;

/** The model the check asks, which is the cheapest there is. */
const MODEL_NAME = 'haiku';

export const hostName = (agent: string): string =>
  agent === 'claude-code' ? 'Claude Code' : outsideLine(agent);

const hostWithVersion = (agent: string, version: string | null): string =>
  version === null ? hostName(agent) : `${hostName(agent)} ${outsideLine(version)}`;

// ---------------------------------------------------------------------------------------------
// Probes and reasons in words.

const PROBE_NAMES: Readonly<Record<string, string>> = {
  allow: 'allow (echo to a file)',
  'secret-egress': 'secret egress (curl, made-up key)',
  deny: 'git hook (write under .git)',
};

const baseIdOf = (id: string): string =>
  isControlId(id) ? id.slice(0, id.length - CONTROL_SUFFIX.length) : id;

export const probeName = (id: string): string => {
  const base = baseIdOf(id);
  return Object.hasOwn(PROBE_NAMES, base) ? (PROBE_NAMES[base] ?? '') : outsideLine(base);
};

/** The row label: a control is the same command with the hook out of the way, and says so. */
const rowLabel = (id: string): string =>
  isControlId(id) ? '  same, hook out of the way' : probeName(id);

const REASON_TEXT: Readonly<Record<string, string>> = {
  ran: 'ran, as the policy allows',
  blocked: 'stopped by the hook',
  armed: 'ran with the hook out of the way',
  'executed-despite-deny': 'ran although the hook said deny',
  'hook-bypassed': 'ran and the hook was never called',
  'policy-mismatch': 'the hook decided otherwise than your policy',
  'not-issued': 'the model did not issue the command',
  'billing-unknown': 'the host did not say how it is paid for',
  'cwd-mismatch': 'the host ran in another directory than the check made',
  limit: 'the plan hit a usage limit',
  auth: 'nobody is logged in',
  'api-billing': 'the host is paid for by an API key or a cloud',
  timeout: 'the host did not answer in time',
  'host-error': 'the host failed',
  'unparsable-stream': 'the output of the host could not be read',
  'command-altered': 'the model changed the command',
  'extra-activity': 'the host did more than the one command',
  'control-extra-activity': 'the host did more than the one command',
  'control-errored': 'the host reported an error for the command',
  'audit-nonce-missing': 'the hook judged other commands, not this one',
  'no-audit-entry': 'the hook left no record',
  'effect-missing': 'the hook allowed it but it did not run',
  'evidence-conflict': 'the evidence disagrees with itself',
  'sentinel-unreadable': 'the file of the probe could not be looked at',
  'audit-unreadable': 'the record of the hook could not be read',
  'probe-not-armed': 'the host does not run this command even with the hook out of the way',
  'control-inconclusive': 'the control run could not confirm it',
  'deny-not-proven-armed': 'no control run was made',
  'skipped-policy-allows': 'your policy does not deny it, so there is nothing to prove',
  'skipped-policy-blocks-allow': 'your policy does not allow it',
  'host-not-found': 'the host was not found',
  budget: 'the budget for live checks is spent',
  'max-requests': 'the limit on requests for this run',
  'allow-not-passed': 'the allow probe did not pass, so this was not run',
  'unsafe-directory': 'the folder of the check was not safe to use',
  'cannot-clear': 'the file of the probe could not be cleared',
};

/** A reason in words; one that is not known is shown as it is, made safe. */
export const reasonText = (reason: string | undefined): string => {
  if (reason === undefined) return '';
  return Object.hasOwn(REASON_TEXT, reason) ? (REASON_TEXT[reason] ?? '') : outsideLine(reason);
};

const markText = (mark: string): string => outsideLine(mark.replace(/-/g, ' '));

// ---------------------------------------------------------------------------------------------
// The table.

const pad = (text: string, width: number): string =>
  text.length >= width ? `${text} ` : `${text}${' '.repeat(width - text.length)}`;

function tableLines(probes: readonly ProbeResult[]): string[] {
  if (probes.length === 0) return [];
  const lines = [`  ${pad('Probe', NAME_WIDTH)}${pad('Mark', MARK_WIDTH)}Why`];
  for (const probe of probes) {
    lines.push(
      `  ${pad(rowLabel(probe.id), NAME_WIDTH)}${pad(markText(probe.mark), MARK_WIDTH)}${reasonText(probe.reason)}`,
    );
    // What was found, for a probe that did not pass: the reason alone does not say it.
    if (probe.mark !== 'passed' && probe.detail !== undefined && probe.detail !== '')
      lines.push(
        ...wrapKeeping(outsideLine(probe.detail), WIDTH - 6).map((line) => `      ${line}`),
      );
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The verdict.

const bullet = (text: string): string[] =>
  wrapKeeping(text, WIDTH - 4).map((line, i) => (i === 0 ? `  - ${line}` : `    ${line}`));

const sentences = (text: string): string[] =>
  wrapKeeping(text, WIDTH - 2).map((line) => `  ${line}`);

const distinct = (items: readonly string[]): string[] => [...new Set(items)];

function failedWords(probes: readonly ProbeResult[]): string {
  const found = probes
    .filter((probe) => probe.mark === 'failed')
    .map((probe) => `${rowLabel(probe.id).trim()}: ${reasonText(probe.reason)}`);
  return found.slice(0, 3).join('; ');
}

function doubtWords(probes: readonly ProbeResult[]): string {
  const reasons = distinct(
    probes
      .filter((probe) => probe.mark !== 'passed' && probe.reason !== undefined)
      .map((probe) => reasonText(probe.reason)),
  );
  return reasons.slice(0, 3).join('; ');
}

/** The verdict, as paragraphs of lines. */
function verdictLines(report: ProveReport): string[] {
  const host = hostWithVersion(report.agent, report.hostVersion);
  if (report.mode === 'stand-in')
    return sentences(
      'STAND-IN. A double of the host answered, so nothing is known of the real one. The probes above are what the double did.',
    );
  switch (report.state) {
    case 'verified':
      return [
        ...sentences(
          `VERIFIED. This shows that the hook line \`stroq init\` writes, run by ${host}, stopped a command your policy denies, and that the same command runs when the hook is out of the way.`,
        ),
        ...sentences(
          `It does not show that your own settings file is loaded, or that other versions of ${hostName(report.agent)} or other hosts behave the same.`,
        ),
      ];
    case 'failed':
      return sentences(`FAILED. The hook did not hold on ${host}: ${failedWords(report.probes)}.`);
    case 'inconclusive':
      return sentences(
        `NOT PROVEN. The check could not tell: ${doubtWords(report.probes)}. Nothing was shown either way.`,
      );
    case 'unsupported':
      return sentences(`NOT SUPPORTED. ${whyNot(report)}`);
    default:
      return sentences(`NOT RUN. ${whyNot(report)}`);
  }
}

/** Why a check did not run: the reasons of its probes, or what the command said. */
function whyNot(report: ProveReport): string {
  const words = doubtWords(report.probes);
  if (words !== '') return `${words}.`;
  const first = report.caveats[0];
  return first === undefined ? 'Nothing was asked of the host.' : endWithStop(outsideLine(first));
}

const endWithStop = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

// ---------------------------------------------------------------------------------------------

/** The whole report: the title, the table, the verdict, the caveats the result carries, the advice. */
export function renderReport(report: ProveReport): string {
  const lines: string[] = [`stroq prove: ${hostWithVersion(report.agent, report.hostVersion)}`, ''];
  const table = tableLines(report.probes);
  if (table.length > 0) lines.push(...table, '');
  lines.push('Verdict', ...verdictLines(report), '');
  lines.push(`Requests made: ${report.requestsMade}`);
  if (report.mode === 'live' && report.caveats.length > 0)
    lines.push(`Caveats: ${report.caveats.map(outsideLine).join(', ')}`);
  if (report.advice.length > 0) {
    lines.push('', 'Advice');
    for (const line of report.advice) lines.push(...bullet(outsideLine(line)));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// What is said before anything is done.

export interface NoticeFacts {
  readonly agent: string;
  readonly hostVersion: string | null;
  readonly maxRequests: number;
}

/** What a run costs and does, said before it is agreed to and again when it is agreed to in advance. */
export function noticeText(facts: NoticeFacts): string[] {
  const host = hostWithVersion(facts.agent, facts.hostVersion);
  const requests = `${facts.maxRequests} short request${facts.maxRequests === 1 ? '' : 's'}`;
  return [
    ...wrapKeeping(
      `stroq prove sends up to ${requests} to ${host} (model: ${MODEL_NAME}), with your own login.`,
      WIDTH,
    ),
    ...bullet(
      "They count against your subscription usage. The login is your subscription's, never an API key; Stroq stops the host at once if it sees one.",
    ),
    ...bullet(
      'Everything happens in a temporary folder that is removed afterwards. It does not change any file of yours.',
    ),
    ...bullet(
      "The model is asked to run three harmless commands, one per request; Stroq's hook decides whether each one runs.",
    ),
  ];
}

export interface DryRunFacts extends NoticeFacts {
  /** `default`, or the path of the policy file. */
  readonly policy: string;
  readonly hookLine: string;
}

/** What `--dry-run` says it would do. */
export function dryRunText(facts: DryRunFacts): string[] {
  return [
    'Dry run: nothing was done and no request was made.',
    '',
    `Would check:  ${hostWithVersion(facts.agent, facts.hostVersion)}`,
    `Would make:   up to ${facts.maxRequests} short request${facts.maxRequests === 1 ? '' : 's'} (model: ${MODEL_NAME}, your own login)`,
    `Hook line:    ${outsideLine(facts.hookLine)}`,
    `Using the policy: ${outsideLine(facts.policy)}`,
    '',
    'Probes, in this order (one that your policy does not deny is skipped):',
    ...['allow', 'secret-egress', 'deny'].map((id) => `  - ${probeName(id)}`),
    'A probe that is stopped is run again with the hook out of the way, to show the host would have run it.',
  ];
}
