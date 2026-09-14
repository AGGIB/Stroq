import type { ContextSurface } from './context-surface.js';
import { sortFindings, type Finding } from './findings.js';
import type { McpSurface } from './mcp-surface.js';
import type { PrivilegeHit } from './privilege-surface.js';
import type { Reach } from './reach.js';
import type { AgentSurface } from './surface.js';

export interface ExposureReport {
  readonly version: 1;
  /** True when `--probe` ran and MCP tool descriptions were read from live servers. */
  readonly probed: boolean;
  readonly agents: readonly AgentSurface[];
  readonly mcp: readonly McpSurface[];
  readonly context: ContextSurface;
  readonly privilege: readonly PrivilegeHit[];
  readonly reach: Reach;
  readonly findings: readonly Finding[];
}

const row = (label: string, value: number | string, note = ''): string =>
  `  ${label.padEnd(26)}${String(value).padStart(5)}   ${note}`.trimEnd();

const sum = <T>(items: readonly T[], pick: (t: T) => number): number =>
  items.reduce((n, t) => n + pick(t), 0);

export function formatExposure(
  report: ExposureReport,
  opts: { readonly verbose?: boolean } = {},
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
    row('Incidents reaching you', report.reach.passedPolicy, `of ${report.reach.total}`),
    '',
  ];

  if (opts.verbose && ctx.flagged.length > 0) {
    lines.push('Flagged files:', ...ctx.flagged.map((f) => `  ${f}`), '');
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

  lines.push(
    '',
    report.probed
      ? 'MCP servers were started and their tool descriptions scanned (--probe).'
      : 'Files only: no MCP server was started. Tool-description poisoning is NOT covered by this run — add --probe to check it.',
  );
  return `${lines.join('\n')}\n`;
}
