import type { ContextSurface } from './context-surface.js';
import type { Drift } from './inventory.js';
import { sortFindings, type Finding } from './findings.js';
import type { McpSurface } from './mcp-surface.js';
import type { PrivilegeHit } from './privilege-surface.js';
import type { Reach } from './reach.js';
import type { RepoSurface } from './repo-surface.js';
import type { AgentSurface } from './surface.js';

/** A server `--probe` tried to start and could not, with the reason it gave. */
export interface ProbeFailure {
  readonly server: string;
  readonly error: string;
}

export interface ExposureReport {
  readonly version: 1;
  /** True when `--probe` ran and MCP tool descriptions were read from live servers. */
  readonly probed: boolean;
  /**
   * The servers `--probe` could not read. Carried separately from `findings`
   * because a server that would not start is a gap in this run's coverage, not
   * evidence of an attack: making it a finding would exit 1 on every machine with
   * one broken config entry. Reporting it is not optional either — a probe result
   * used to be dropped when it carried an error, so the footer went on claiming the
   * tool descriptions had been scanned when nothing had been read at all.
   */
  readonly probeFailures: readonly ProbeFailure[];
  readonly agents: readonly AgentSurface[];
  readonly mcp: readonly McpSurface[];
  readonly context: ContextSurface;
  readonly privilege: readonly PrivilegeHit[];
  readonly repo: RepoSurface;
  readonly reach: Reach;
  readonly findings: readonly Finding[];
}

const row = (label: string, value: number | string, note = ''): string =>
  `  ${label.padEnd(26)}${String(value).padStart(5)}   ${note}`.trimEnd();

const sum = <T>(items: readonly T[], pick: (t: T) => number): number =>
  items.reduce((n, t) => n + pick(t), 0);

/**
 * The one line that says what this run actually covered. It has to distinguish
 * three states, not two: no probe, a probe that read every server, and a probe that
 * read some and could not start the rest. The third used to read exactly like the
 * second, which is how a Windows run — where an `npx`-launched server does not
 * start at all — could report a scan it never performed.
 */
function probeFooter(report: ExposureReport): string {
  if (!report.probed)
    return 'Files only: no MCP server was started. Tool-description poisoning is NOT covered by this run — add --probe to check it.';
  const failures = report.probeFailures;
  if (failures.length === 0)
    return 'MCP servers were started and their tool descriptions scanned (--probe).';
  const named = failures.map((f) => `${f.server} (${f.error})`).join(', ');
  return `MCP servers were started and their tool descriptions scanned (--probe) — but ${failures.length} of them could not be started, so tool-description poisoning is NOT covered for: ${named}`;
}

/**
 * What appeared or changed among the instruction and skill files since the last run;
 * see `Drift`. Printed with the flag from this run's scan beside each, since a changed
 * file is worth reading either way and a flagged one first.
 */
const DRIFT_LINES = 10;

function driftLines(drift: Drift, flagged: ReadonlySet<string>, verbose: boolean): string[] {
  const total = drift.added.length + drift.changed.length;
  if (drift.baseline || total === 0) return [];
  const mark = (path: string): string => (flagged.has(path) ? '  (flagged)' : '');
  const all = [
    ...drift.changed.map((path) => `  changed  ${path}${mark(path)}`),
    ...drift.added.map((path) => `  new      ${path}${mark(path)}`),
  ];
  // A plugin update can touch dozens of files; the rest are one flag away.
  const shown = verbose ? all : all.slice(0, DRIFT_LINES);
  const hidden = all.length - shown.length;
  return [
    `Changed since the last run (${total}): read these if you did not change them yourself.`,
    ...shown,
    ...(hidden > 0 ? [`  …and ${hidden} more (--verbose lists them all)`] : []),
    '',
  ];
}

export function formatExposure(
  report: ExposureReport,
  opts: { readonly verbose?: boolean; readonly drift?: Drift } = {},
): string {
  const detected = report.agents.filter((a) => a.detected);
  const unprotected = detected.filter((a) => !a.protected);
  const stdio = sum(report.mcp, (m) => m.stdio);
  const wrapped = sum(report.mcp, (m) => m.wrapped);
  const http = sum(report.mcp, (m) => m.http);
  const ctx = report.context;

  const lines: string[] = [
    'stroq exposure — what reaches you on this machine',
    '',
    row('Agents detected', detected.length, detected.map((a) => a.agent).join(', ')),
    row('protected', detected.length - unprotected.length),
    row('unprotected', unprotected.length, unprotected.map((a) => a.agent).join(', ')),
    '',
    row('MCP servers', stdio + http),
    row('wrapped by Stroq', wrapped),
    row('stdio, unwrapped', stdio - wrapped),
    row('http (out of reach)', http),
    '',
    row(
      'Context the agent reads',
      ctx.skills + ctx.subagents + ctx.commands + ctx.instructionFiles,
      `${Math.round(ctx.bytes / 1024)} KB${ctx.capped ? ' — a lower bound: discovery hit its file cap' : ''}`,
    ),
    row('skills', ctx.skills),
    row('subagents', ctx.subagents),
    row('commands', ctx.commands),
    row('instruction files', ctx.instructionFiles),
    row('non-Stroq hooks', ctx.foreignHooks),
    row(
      'flagged by rules',
      ctx.flagged.length,
      ctx.flagged.length > 0 ? 'expect false positives — see the finding' : '',
    ),
    '',
    row('Privilege-widening keys', report.privilege.length),
    row(
      'Repository runs on open',
      report.repo.isRepo ? report.repo.onOpen.length + report.repo.preTrust.length : 0,
      report.repo.isRepo
        ? `${report.repo.preTrust.length} before you approve anything${report.repo.capped ? ' — a lower bound: the walk hit its cap' : ''}`
        : 'not a git repository',
    ),
    row('Incidents reaching you', report.reach.passedPolicy, `of ${report.reach.total}`),
    '',
  ];

  if (opts.verbose && ctx.flagged.length > 0) {
    lines.push('Flagged files:', ...ctx.flagged.map((f) => `  ${f}`), '');
  }

  if (opts.drift?.baseline === true) {
    const recorded = Object.keys(ctx.digests).length;
    lines.push(
      `Recorded ${recorded} instruction and skill file${recorded === 1 ? '' : 's'}; the next run names any that appear or change.`,
      '',
    );
  } else if (opts.drift) {
    lines.push(...driftLines(opts.drift, new Set(ctx.flagged), opts.verbose === true));
  }

  // The on-open list is surface, not a finding: a husky hook or a `prepare` script is
  // ordinary, and raising one would fail this command on most honest repositories.
  // It is still worth seeing, so --verbose prints it.
  if (opts.verbose && report.repo.onOpen.length > 0) {
    lines.push(
      'Runs when you open or build this repository:',
      ...report.repo.onOpen.map((h) => `  ${h.file} — ${h.what}`),
      '',
    );
  }

  const findings = sortFindings(report.findings);
  if (findings.length === 0) {
    lines.push('No findings. Everything Stroq can check on this machine is covered.');
  } else {
    lines.push(`FINDINGS (${findings.length})`);
    for (const f of findings) {
      lines.push(`${f.severity.toUpperCase().padEnd(9)} ${f.class}`);
      lines.push(`          ${f.detail}`);
      if (f.fix) lines.push(`          fix: ${f.fix}`);
    }
  }

  lines.push('', probeFooter(report));
  return `${lines.join('\n')}\n`;
}
