import { quotePath } from '../install/safe-path.js';
import { outsideLine } from '../ui/layout.js';
import type { Change, NotJudged } from './diff.js';
import type { AttackPass, Interruption, TestReport, Violation } from './test-report.js';

/** The most lines one section lists in the text form; `--json` lists every one. */
const MAX_LISTED = 60;

const SHA_SHOWN = 12;

/** A scenario id, which a person wrote (or a hostile file did), shown with its odd characters spelled out. */
const idOf = (id: string): string => quotePath(id).slice(1, -1);

const ruleOf = (ruleId: string | null): string =>
  ruleId === null ? 'default' : `rule ${quotePath(ruleId)}`;

function section(title: string, rows: readonly string[]): string[] {
  if (rows.length === 0) return [`${title}: none`, ''];
  const listed = rows.slice(0, MAX_LISTED).map((row) => `  ${row}`);
  const hidden = rows.length - listed.length;
  const more =
    hidden > 0 ? [`  ... and ${hidden} more (stroq policy test --json lists every one)`] : [];
  return [`${title}: ${rows.length}`, ...listed, ...more, ''];
}

const changeRow = (c: Change): string =>
  `${idOf(c.id)}/${c.step}: ${c.baseline} -> ${c.candidate} (${c.direction})`;

const passRow = (p: AttackPass): string => {
  const baseline = p.new
    ? 'new: the baseline does not let it through'
    : 'the baseline lets it through too';
  return `${idOf(p.id)}/${p.step} (${p.suite === 'cases' ? `your case, ${baseline}` : baseline})`;
};

const interruptionRow = (i: Interruption): string =>
  `${idOf(i.id)}/${i.step}: ${i.baseline} -> ${i.candidate} (${ruleOf(i.ruleId)})` +
  (i.subject === '' ? '' : ` ${i.tool}: ${outsideLine(i.subject)}`);

const violationRow = (v: Violation): string =>
  `${idOf(v.id)}/${v.step}: expected ${v.expected}, got ${v.actual ?? 'no answer'}`;

const WHICH = { baseline: 'the baseline run', candidate: 'the candidate run', both: 'both runs' };
const SUITE = { attack: 'attack corpus', ordinary: 'ordinary-work corpus', cases: 'your cases' };

const notJudgedRow = (n: NotJudged): string => `${idOf(n.id)}: ${SUITE[n.suite]}, ${WHICH[n.why]}`;

function header(report: TestReport): string[] {
  const ref = (p: TestReport['candidate']): string =>
    `${outsideLine(p.source)} (sha256 ${p.sha256.slice(0, SHA_SHOWN)})`;
  const { attack, ordinary, cases } = report.replayed;
  return [
    `stroq policy test: candidate ${ref(report.candidate)} against baseline ${ref(report.baseline)}`,
    `replayed under both: attack corpus ${attack}, ordinary-work corpus ${ordinary}, your cases ${cases}`,
    '',
  ];
}

/**
 * The report as a person reads it: first every step whose decision changed, one line each, then what
 * the changes add up to. Everything that came from a file arrives neutralized; ids are spelled out.
 */
export function formatTest(report: TestReport): string {
  const cases =
    report.replayed.cases === 0
      ? []
      : section('Your expectations violated', report.violations.map(violationRow));
  const lines = [
    ...header(report),
    ...section('Changed decisions', report.changes.map(changeRow)),
    ...section('Attacks that pass under the candidate', report.attacksPassing.map(passRow)),
    ...section('New interruptions of ordinary work', report.newInterruptions.map(interruptionRow)),
    ...section('Ordinary work no longer interrupted', report.relieved.map(interruptionRow)),
    ...cases,
    ...section(
      'Not judged (a timeout or an error is not a defence)',
      report.notJudged.map(notJudgedRow),
    ),
    report.ok ? 'Result: ok' : `Result: FAILED (${report.failures.join('; ')})`,
  ];
  return `${lines.join('\n')}\n`;
}
