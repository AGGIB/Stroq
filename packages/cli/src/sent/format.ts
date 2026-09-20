// Rendering a retroactive exposure report as something a developer will believe.
//
// The hard part here is not the layout, it is the claim. "A credential reached the
// model" is true and useful; "you were breached" is neither, and a command that
// implies the second gets discounted along with everything else the project says. So
// the disclaimer below is not boilerplate to skim past — it is the part that makes
// the finding actionable, and it is asserted in the tests.
import { ageLabel } from '@stroq/core';
import type { SentCredential, SentFileEvidence, SentOccurrence, SentReport } from './report.js';

const VIA_LABEL: Readonly<Record<SentOccurrence['via'], string>> = {
  tool_result: 'in the result of  ',
  tool_argument: 'in the arguments of',
};

/**
 * One clause per evidence kind, because the two are not the same observation and
 * printing them identically is how a report loses a reader who knows the difference.
 */
const FILE_EVIDENCE_LINE: Readonly<Record<SentFileEvidence, string>> = {
  read: 'its contents came back to the model',
  named: 'named in the command; whether its contents were printed depends on the command',
};

function timestamp(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? 'an unrecorded time' : iso.replace('.000Z', 'Z');
}

function duration(report: SentReport): string {
  if (!report.first || !report.last) return '';
  return ` · ${ageLabel(report.first, new Date(report.last))} long`;
}

function origin(report: SentReport): string {
  if (report.origin === 'audit-log') {
    return "  from Stroq's own audit log";
  }
  return `  from ${report.path ?? 'a transcript'} (${report.agent ?? 'agent'} transcript)`;
}

function occurrenceLine(occurrence: SentOccurrence, last: boolean): string {
  const elbow = last ? '      └─' : '      ├─';
  return `${elbow} ${VIA_LABEL[occurrence.via]}  ${occurrence.tool.padEnd(10)} ${occurrence.call}`;
}

function credentialBlock(credential: SentCredential): string[] {
  const mark = credential.canary ? '◆' : '●';
  const tag = credential.canary ? '  (a Stroq canary — you planted this to find out)' : '';
  const times = credential.count === 1 ? 'once' : `${credential.count} times`;
  const shown = credential.occurrences;
  const hidden = credential.count - shown.length;
  return [
    `  ${mark} ${credential.name} — ${credential.source}${tag}`,
    `      seen ${times}, first at ${timestamp(credential.first)}`,
    ...shown.map((o, i) => occurrenceLine(o, i === shown.length - 1 && hidden === 0)),
    ...(hidden > 0 ? [`      └─ and ${hidden} more`] : []),
    '',
  ];
}

/**
 * The limits of the answer, printed whether or not anything was found. A run that
 * matched against an empty index and a run that matched against forty credentials
 * both print "nothing found" without this, and only one of them means it.
 */
function coverageLines(report: SentReport): string[] {
  const c = report.coverage;
  const sources =
    c.indexedSources.length > 0 ? c.indexedSources.join(', ') : 'nothing on this machine';
  const lines = [
    'COVERAGE',
    `  Matched against ${c.indexedSecrets} value(s) indexed from: ${sources}`,
    '  Reading those credential files is what this command does; it opens nothing else,',
    '  and it stores and prints names and sources only, never a value.',
    '  Credential-shaped variables in the environment this command ran with are matched',
    '  too, and are not counted above.',
    '  A credential you have rotated or deleted since that session is not in the index,',
    '  so it cannot appear above.',
  ];
  if (c.toolResultsRead) {
    lines.push(
      `  Tool results were read in full from the agent's own transcript (${c.results} of ${c.calls} calls).`,
    );
  } else {
    lines.push(
      '  The audit log records what each call SENT, never what came back, so only tool',
      '  arguments and credential-file reads are covered here. Run `stroq sent --last`',
      "  to read the agent's own transcript instead, which still has the result text.",
    );
  }
  return lines;
}

/**
 * The claim, stated at its real strength and no higher. Content reaching a model
 * provider is not an incident — it is how a coding agent works — so the finding is
 * "this specific credential was in that traffic and you may not have known", and the
 * action it supports is rotation, not panic.
 */
const MEANING: readonly string[] = [
  'WHAT THIS SAYS, AND WHAT IT DOES NOT',
  '  What is above was in the text of that session, so it went to the model provider',
  '  along with everything else in it. That is how a coding agent works.',
  '  Nothing here says the provider retained any of it, that a person ever saw it, or',
  '  that this was a breach. It says the value was in that traffic, and that you may',
  '  not have known it was.',
  '  If one of them matters, rotate it. Rotating is cheap; being sure is not.',
];

export function formatSent(report: SentReport): string {
  const lines: string[] = [
    'stroq sent — which of your credentials already reached a model provider',
    '',
    `  session ${report.sessionId} · ${report.coverage.calls} tool call(s)${duration(report)}`,
    origin(report),
    '',
  ];

  if (report.credentials.length > 0) {
    lines.push(
      `CREDENTIALS THAT WERE IN THIS SESSION'S TRAFFIC (${report.credentials.length})`,
      '',
    );
    for (const credential of report.credentials) lines.push(...credentialBlock(credential));
  }

  if (report.files.length > 0) {
    lines.push(`CREDENTIAL FILES THIS SESSION TOUCHED (${report.files.length})`, '');
    for (const file of report.files) {
      lines.push(`  ■ ${file.path} — ${file.tool} at ${timestamp(file.at)}`);
      lines.push(`      ${FILE_EVIDENCE_LINE[file.evidence]}`);
    }
    if (report.files.some((f) => f.evidence === 'read')) {
      lines.push(
        '',
        '  A file whose contents came back was sent to the model whole, including any',
        '  value Stroq does not have indexed and therefore could not name above.',
      );
    }
    lines.push('');
  }

  if (report.credentials.length === 0 && report.files.length === 0) {
    lines.push(
      'No indexed credential appeared in this session, and no credential file was',
      'read or named by it. Read the coverage below before treating that as clean.',
      '',
    );
  } else {
    lines.push(...MEANING, '');
  }

  lines.push(...coverageLines(report));
  return `${lines.join('\n')}\n`;
}
