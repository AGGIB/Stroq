// Rendering a retroactive exposure report as something a developer will believe.
//
// The hard part here is not the layout, it is the claim. A local transcript proves
// where a credential appeared in that record; it does not prove a later model
// request or delivery to a provider. The distinction is asserted in the tests.
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
  read: 'a Read/Grep call was recorded for this path; its returned content is not established here',
  named: 'named in a shell command; whether it read or printed the file is unknown',
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
    '  To match known values, this command reads supported local credential files',
    '  and project .env sources. It stores and prints names and sources, never values.',
    '  Credential-shaped variables in the environment this command ran with are matched',
    '  too, and are not counted above.',
    '  A credential you have rotated or deleted since that session is not in the index,',
    '  so it cannot appear above.',
  ];
  if (c.toolResultsRead) {
    lines.push(
      `  Recorded tool result text was scanned from the agent transcript (${c.results} of ${c.calls} calls).`,
    );
  } else {
    lines.push(
      '  The audit log records call arguments, never what came back, so only recorded',
      '  argument matches and supported file-path references are covered here.',
      "  Run `stroq sent --last` to read the agent's own transcript instead,",
      '  which may still have the result text.',
    );
  }
  return lines;
}

/**
 * The claim, stated at its real strength and no higher. A local record establishes
 * a match or file reference, not a later model request, provider delivery, or the
 * current validity of a credential.
 */
const MEANING: readonly string[] = [
  'WHAT THIS SAYS, AND WHAT IT DOES NOT',
  '  These findings come from a local agent transcript or Stroq audit log.',
  '  Where shown, a matching value appeared in a tool result or call argument.',
  '  A file entry records a supported tool using or naming its path.',
  '  This record alone cannot confirm a later model request, delivery to a provider,',
  '  the recipient, retention, human access, or whether a credential is still valid.',
  '  It does not prove a breach. Review the session and rotate active credentials',
  '  when the potential exposure warrants it.',
];

/**
 * Where a credential of this kind is rotated, when its name or source says which
 * provider issued it. A finding that ends in "rotate it" and no address is one more
 * search the user has to do before acting on it.
 */
const ROTATE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\baws|aws_/i, 'https://console.aws.amazon.com/iam/home#/security_credentials'],
  [/github|\bgh_|^gh[a-z]?_/i, 'https://github.com/settings/tokens'],
  [/npm|_authtoken/i, 'https://www.npmjs.com/settings/~/tokens'],
  [/openai/i, 'https://platform.openai.com/api-keys'],
  [/anthropic/i, 'https://console.anthropic.com/settings/keys'],
  [/stripe/i, 'https://dashboard.stripe.com/apikeys'],
];

const rotationUrl = (credential: SentCredential): string | null =>
  ROTATE.find(([pattern]) => pattern.test(`${credential.name} ${credential.source}`))?.[1] ?? null;

/**
 * The one line that says what the scan concluded, before any detail: the line a user
 * acts on, and the one they would share. Clean carries the numbers that make it mean
 * something, and a credential file touched without an indexed value is not clean.
 */
function verdictLine(report: SentReport): string {
  const found = report.credentials.length;
  if (found > 0) {
    const names = report.credentials.map((c) => c.name);
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3}` : '');
    return `✗ ${found} known credential value(s) in this session's recorded tool calls: ${shown}`;
  }
  if (report.files.length > 0)
    return `! No known credential value matched, but the session touched ${report.files.length} credential file(s) — see below`;
  const { calls, indexedSecrets, toolResultsRead } = report.coverage;
  return `✓ No known credential value in ${calls} tool call(s), checked against ${indexedSecrets} indexed value(s)${toolResultsRead ? '' : ' — arguments only, see coverage'}`;
}

export function formatSent(report: SentReport): string {
  const lines: string[] = [
    'stroq sent — credential evidence in recorded agent sessions',
    '',
    verdictLine(report),
    '',
    `  session ${report.sessionId} · ${report.coverage.calls} tool call(s)${duration(report)}`,
    origin(report),
    '',
  ];

  if (report.credentials.length > 0) {
    lines.push(`CREDENTIAL VALUES FOUND IN THIS SESSION RECORD (${report.credentials.length})`, '');
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
        "  A Read/Grep result may contain sensitive content absent from today's index.",
        '  Inspect the agent transcript to learn what was actually returned.',
      );
    }
    lines.push('');
  }

  if (report.credentials.length === 0 && report.files.length === 0) {
    lines.push(
      'No indexed credential match or credential-file finding was recorded for',
      'this session. Read the coverage below before treating that as clean.',
      '',
    );
  } else {
    lines.push(...MEANING, '');
  }

  lines.push(...coverageLines(report), '', ...nextLines(report.credentials));
  return `${lines.join('\n')}\n`;
}

/**
 * Where to go from here. A report that ended on its coverage left a newcomer with a
 * finding and no move to make: rotating comes first when there is something to
 * rotate, then the command that shows what the session did, then the one that guards
 * the next session.
 */
function nextLines(credentials: readonly SentCredential[]): string[] {
  const rotations = credentials.flatMap((c) => {
    const url = c.canary ? null : rotationUrl(c);
    return url === null ? [] : [`    ${c.name}: ${url}`];
  });
  return [
    'NEXT',
    ...(credentials.length > 0
      ? ['  Rotate each credential named above that is still live.', ...rotations]
      : []),
    '  stroq replay --last    what the session read, and which later actions matched it',
    '  stroq init             guard the next session (--agent <name> for another agent)',
  ];
}
