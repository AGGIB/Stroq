import type { ExposureReport } from './report.js';

/**
 * What `--share` may contain, and nothing else. Built field-by-field from typed data
 * rather than by stripping a full record: a whitelist cannot leak a field nobody
 * thought about, a blacklist can. Adding a field to `ExposureReport` leaves `--share`
 * unchanged until it is added here on purpose.
 *
 * Agent and client names are product identifiers, not personal data, and privilege
 * keys are configuration key names — both stay. Paths, file names, server names,
 * hostnames, usernames and every free-text `detail` are absent by construction.
 */
export interface ShareableExposure {
  readonly version: 1;
  readonly probed: boolean;
  readonly agentsDetected: number;
  readonly agentsProtected: number;
  readonly mcpStdio: number;
  readonly mcpWrapped: number;
  readonly mcpHttp: number;
  readonly contextFiles: number;
  readonly contextFlagged: number;
  readonly foreignHooks: number;
  readonly privilegeKeys: readonly string[];
  /** Kinds only: a kind is a fixed vocabulary, a path is the user's disk. */
  readonly repoPreTrust: readonly string[];
  readonly repoOnOpen: number;
  readonly reachTotal: number;
  readonly reachPassed: number;
  readonly findings: readonly { readonly class: string; readonly severity: string }[];
}

export function toShareable(report: ExposureReport): ShareableExposure {
  const detected = report.agents.filter((a) => a.detected);
  const c = report.context;
  return {
    version: 1,
    probed: report.probed,
    agentsDetected: detected.length,
    agentsProtected: detected.filter((a) => a.protected).length,
    mcpStdio: report.mcp.reduce((n, m) => n + m.stdio, 0),
    mcpWrapped: report.mcp.reduce((n, m) => n + m.wrapped, 0),
    mcpHttp: report.mcp.reduce((n, m) => n + m.http, 0),
    contextFiles: c.skills + c.subagents + c.commands + c.instructionFiles,
    contextFlagged: c.flagged.length,
    foreignHooks: c.foreignHooks,
    privilegeKeys: report.privilege.map((p) => p.key),
    repoPreTrust: report.repo.preTrust.map((h) => h.kind),
    repoOnOpen: report.repo.onOpen.length,
    reachTotal: report.reach.total,
    reachPassed: report.reach.passedPolicy,
    findings: report.findings.map((f) => ({ class: f.class, severity: f.severity })),
  };
}

export function formatShareable(share: ShareableExposure): string {
  const lines = [
    'stroq exposure (shareable summary)',
    '',
    `  agents detected        ${share.agentsDetected}, protected ${share.agentsProtected}`,
    `  MCP stdio servers      ${share.mcpStdio}, wrapped ${share.mcpWrapped}, http out of reach ${share.mcpHttp}`,
    `  instruction files      ${share.contextFiles}, flagged ${share.contextFlagged}`,
    `  non-Stroq hooks        ${share.foreignHooks}`,
    `  privilege keys set     ${share.privilegeKeys.length > 0 ? share.privilegeKeys.join(', ') : 'none'}`,
    `  repo runs on open      ${share.repoOnOpen}, before approval ${share.repoPreTrust.length > 0 ? share.repoPreTrust.join(', ') : 'none'}`,
    `  incidents reaching me  ${share.reachPassed} of ${share.reachTotal}`,
    '',
    share.findings.length === 0
      ? '  no findings'
      : `  findings: ${share.findings.map((f) => `${f.class} (${f.severity})`).join(', ')}`,
    '',
    share.probed ? '  MCP servers were probed.' : '  Files only — MCP servers were not started.',
    '',
    '  Generated locally by stroq exposure --share. Nothing was transmitted.',
  ];
  return `${lines.join('\n')}\n`;
}
