import { homedir } from 'node:os';
import { runAttack } from '../attack/run.js';
import { SCENARIOS } from '../attack/scenarios/index.js';
import { loadPolicy, policySource } from '../engine-factory.js';
import { contextFindings, contextSurface } from '../exposure/context-surface.js';
import type { Finding } from '../exposure/findings.js';
import { mcpFindings, mcpSurface } from '../exposure/mcp-surface.js';
import { privilegeFindings, privilegeSurface } from '../exposure/privilege-surface.js';
import { probeFindings, probeServers } from '../exposure/probe.js';
import { reachFindings, reachFrom } from '../exposure/reach.js';
import { repoFindings, repoSurface } from '../exposure/repo-surface.js';
import { formatShareable, toShareable } from '../exposure/redact.js';
import { formatExposure, type ExposureReport } from '../exposure/report.js';
import { agentFindings, agentSurface } from '../exposure/surface.js';

export async function buildExposureReport(
  cwd: string,
  opts: { readonly probe?: boolean },
): Promise<ExposureReport> {
  const home = homedir();
  const agents = agentSurface(cwd, home);
  const mcp = mcpSurface(cwd);
  const context = contextSurface(cwd, home);
  const privilege = privilegeSurface(cwd, home);
  const repo = repoSurface(cwd);
  const attack = await runAttack(SCENARIOS, loadPolicy(), policySource());
  const reach = reachFrom(attack, agents);
  const probes = opts.probe === true ? await probeServers(mcp) : [];
  const findings: readonly Finding[] = [
    ...agentFindings(agents),
    ...mcpFindings(mcp),
    ...contextFindings(context),
    ...privilegeFindings(privilege),
    ...repoFindings(repo),
    ...reachFindings(reach),
    ...probeFindings(probes),
  ];
  return {
    version: 1,
    probed: opts.probe === true,
    agents,
    mcp,
    context,
    privilege,
    repo,
    reach,
    findings,
  };
}

export async function runExposure(argv: readonly string[]): Promise<number> {
  const report = await buildExposureReport(process.cwd(), { probe: argv.includes('--probe') });
  const share = argv.includes('--share');
  if (argv.includes('--json')) {
    const payload = share ? toShareable(report) : report;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      share
        ? formatShareable(toShareable(report))
        : formatExposure(report, { verbose: argv.includes('--verbose') }),
    );
  }
  // Exit 1 on any finding, so `stroq exposure` works in CI and in a pre-commit hook
  // without a wrapper that has to parse the report.
  return report.findings.length > 0 ? 1 : 0;
}
