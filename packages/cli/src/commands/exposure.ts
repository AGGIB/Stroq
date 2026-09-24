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
import {
  compareInventory,
  readInventory,
  writeInventory,
  type Drift,
} from '../exposure/inventory.js';
import { formatExposure, type ExposureReport } from '../exposure/report.js';
import { inventoryFile } from '../paths.js';
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
    // Every probe that came back with an error rather than a tool list. These are
    // not findings — a server that will not start is a broken config entry, not an
    // attack — but they are the difference between "scanned and clean" and "never
    // read", and the report has to be able to tell them apart.
    probeFailures: probes
      .filter((p) => p.error !== null)
      .map((p) => ({ server: p.server, error: p.error as string })),
    agents,
    mcp,
    context,
    privilege,
    repo,
    reach,
    findings,
  };
}

/**
 * Compares this run's instruction and skill files with the last run's, then records
 * this run's. A record that cannot be written costs only the next comparison, so it
 * is reported on stderr and never fails the command.
 */
function recordInventory(digests: Readonly<Record<string, string>>): Drift {
  const file = inventoryFile();
  const drift = compareInventory(readInventory(file), digests);
  try {
    writeInventory(file, digests);
  } catch (err) {
    process.stderr.write(`stroq exposure: could not record ${file}: ${(err as Error).message}\n`);
  }
  return drift;
}

export async function runExposure(argv: readonly string[]): Promise<number> {
  const report = await buildExposureReport(process.cwd(), { probe: argv.includes('--probe') });
  const share = argv.includes('--share');
  const drift = recordInventory(report.context.digests);
  if (argv.includes('--json')) {
    // `--share` stays field-by-field typed data: file paths never reach it.
    const payload = share ? toShareable(report) : { ...report, drift };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      share
        ? formatShareable(toShareable(report))
        : formatExposure(report, { verbose: argv.includes('--verbose'), drift }),
    );
  }
  // Exit 1 on any finding, so `stroq exposure` works in CI and in a pre-commit hook
  // without a wrapper that has to parse the report.
  return report.findings.length > 0 ? 1 : 0;
}
