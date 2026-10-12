import type { CheckReport } from './check.js';
import type { Severity } from './findings.js';

/** The most faults or findings the text form lists; `--json` lists every one. */
const MAX_SHOWN = 40;

const LABEL: Readonly<Record<Severity, string>> = {
  error: 'error   ',
  warning: 'warning ',
  info: 'note    ',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Row {
  readonly severity: Severity;
  readonly message: string;
  readonly fix: string;
}

function rowLines(row: Row): string[] {
  return [
    `${LABEL[row.severity]} ${row.message}`,
    `${' '.repeat(LABEL.error.length + 1)}fix: ${row.fix}`,
  ];
}

function verdictLine(report: CheckReport): string {
  const rows: readonly Row[] = [...report.faults, ...report.findings];
  const count = (severity: Severity): number => rows.filter((r) => r.severity === severity).length;
  const [errors, warnings, notes] = [count('error'), count('warning'), count('info')];
  const note = notes === 0 ? '' : `; ${plural(notes, 'note')}`;
  if (errors + warnings === 0) return `No problems found${note}.`;
  const parts = [
    ...(errors > 0 ? [plural(errors, 'error')] : []),
    ...(warnings > 0 ? [plural(warnings, 'warning')] : []),
  ];
  return `${plural(errors + warnings, 'problem')} (${parts.join(', ')})${note}.`;
}

/** What the file is, in a line: how many rules, the default effect, the threshold. */
function summaryLine(report: CheckReport): string {
  const { policy } = report;
  if (policy === null) {
    return (
      'Stroq cannot use this file. The hook fails closed while it is in place: it denies Bash, ' +
      'edits, fetches and MCP calls until the file loads.'
    );
  }
  return `${plural(policy.rules, 'rule')}, default: ${policy.default}, threshold: ${policy.threshold}`;
}

/**
 * The report as a person reads it. Everything taken from the file arrives already neutralized in the
 * messages; `shownFile` is the path as the person wrote it, made safe by the caller.
 */
export function formatCheck(report: CheckReport, shownFile: string): string {
  const head =
    report.source === 'default'
      ? `stroq policy check: no policy.yaml at ${shownFile}; the built-in default policy is in force. Checking that.`
      : `stroq policy check: ${shownFile}`;
  const rows: readonly Row[] = [...report.faults, ...report.findings];
  const shown = rows.slice(0, MAX_SHOWN).flatMap(rowLines);
  const hidden = rows.length - Math.min(rows.length, MAX_SHOWN);
  const more =
    hidden > 0 ? [`... and ${hidden} more (stroq policy check --json lists every one)`] : [];
  return `${[head, `  ${summaryLine(report)}`, '', ...shown, ...more, ...(rows.length > 0 ? [''] : []), verdictLine(report)].join('\n')}\n`;
}
