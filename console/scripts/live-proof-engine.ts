/** Console adapter of the existing proof engine. No model text or host stderr crosses IPC. */
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy } from '../../packages/cli/src/engine-factory.js';
import { capabilitiesFor } from '../../packages/cli/src/hosts/capabilities.js';
import { openLedger } from '../../packages/cli/src/live/budget.js';
import { createClaudeDriver } from '../../packages/cli/src/live/drivers/claude.js';
import { createCodexDriver } from '../../packages/cli/src/live/drivers/codex.js';
import { codexSpawn } from '../../packages/cli/src/live/drivers/codex-process.js';
import { realSpawn, type HostSpawn } from '../../packages/cli/src/live/drivers/host-process.js';
import { policySha256 } from '../../packages/cli/src/live/policy-digest.js';
import { readSmallRegularFile } from '../../packages/cli/src/live/private-file.js';
import { displayState } from '../../packages/cli/src/live/states.js';
import {
  readDiagnosticResult,
  readHostResult,
  writeHostResult,
} from '../../packages/cli/src/live/store.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../packages/cli/src/live/throwaway.js';
import { parseHostResult, REASONS, type HostDriver } from '../../packages/cli/src/live/types.js';
import { verifyHost } from '../../packages/cli/src/live/verify.js';
import { adviceFor, reportOf } from '../../packages/cli/src/commands/prove-report.js';
import { hookCommand, windowsHookCommands } from '../../packages/cli/src/commands/hook-command.js';
import { stroqHome } from '../../packages/cli/src/paths.js';

const AGENTS = ['claude-code', 'codex'];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.+-]{1,40})?$/;
const knownReasons = new Set<string>(Object.values(REASONS));
const PROBE_IDS = new Set([
  'allow',
  'deny',
  'deny:control',
  'secret-egress',
  'secret-egress:control',
]);
const fixedCaveats = new Set([
  'hook-trust-bypassed',
  'sandbox-disabled',
  'host-free proxy check',
  'no-control-run',
]);

/** Strict source parser and authoritative state evaluator, then a minimal browser projection. */
export function projectHostResult(raw: unknown) {
  const parsed = parseHostResult(raw);
  if (
    !parsed.ok ||
    !AGENTS.includes(parsed.result.agent) ||
    parsed.result.probes.some((probe) => !PROBE_IDS.has(probe.id))
  )
    throw new Error('invalid-report');
  const result = parsed.result;
  const report = reportOf(result);
  return {
    state: report.state,
    mode: report.mode,
    hostVersion:
      result.hostVersion !== null && VERSION.test(result.hostVersion) ? result.hostVersion : null,
    requestsMade: report.requestsMade,
    probes: result.probes.map((probe) => ({
      id: probe.id,
      kind: probe.kind,
      mark: probe.mark,
      ...(probe.reason === undefined
        ? {}
        : { reason: knownReasons.has(probe.reason) ? probe.reason : 'other' }),
      evidence: probe.evidence,
    })),
    caveats: [
      ...new Set(
        report.caveats.map((caveat) =>
          fixedCaveats.has(caveat) || /^deny-text-not-seen:(?:deny|secret-egress)$/.test(caveat)
            ? caveat
            : 'additional-host-caveat',
        ),
      ),
    ],
    advice: adviceFor(report),
  };
}

function installedAt(home: string, agent: string): Date | null {
  const read = readSmallRegularFile(join(home, 'install.json'), 1024 * 1024);
  if (read.kind !== 'text') return null;
  try {
    const raw = JSON.parse(read.text);
    if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return null;
    const times = Object.entries(raw.entries)
      .filter(([key]) => key.startsWith(`${agent}:`))
      .map(([, entry]) => Date.parse((entry as { recordedAt: string }).recordedAt))
      .filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)) : null;
  } catch {
    return null;
  }
}

export function inspectLive(version: string, now = new Date()) {
  const home = stroqHome();
  const digest = policySha256(loadPolicy());
  const proofs: Record<string, unknown> = {};
  for (const agent of AGENTS) {
    const stored = readHostResult(home, agent, now);
    const result = stored.result ?? readDiagnosticResult(home, agent, 'last', now).result;
    if (result === null || result.mode !== 'live') continue;
    try {
      const report = projectHostResult(result);
      const display = displayState({
        capabilities: capabilitiesFor(agent),
        installed: { installed: true, changed: false },
        stampAt: null,
        installRecordedAt: installedAt(home, agent),
        stored: result,
        stroqVersion: version,
        policySha256: digest,
        hostVersion: null,
      });
      proofs[agent] = {
        state: display.state,
        checkedAt: result.at,
        hostVersion: report.hostVersion,
        hostVersionRechecked: false,
        reason:
          display.state === 'stale'
            ? result.stroqVersion !== version
              ? 'engine-changed'
              : result.policySha256 !== digest
                ? 'policy-changed'
                : 'host-version-not-rechecked'
            : 'check-recorded',
        report,
      };
    } catch {
      /* Malformed, unexpected or fabricated inconsistent evidence cannot be a proof. */
    }
  }
  return { policySha256: digest, proofs };
}

function send(message: unknown): void {
  process.send?.(message);
}
const controller = new AbortController();
function trackedSpawn(agent: string): HostSpawn {
  return (file, args, options) => {
    const child = (agent === 'codex' ? codexSpawn : realSpawn)(file, args, {
      ...options,
      env:
        agent === 'claude-code' && process.env['CLAUDE_CONFIG_DIR']
          ? { ...options.env, CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] }
          : options.env,
    });
    if (child.pid) send({ type: 'child', pid: child.pid });
    child.on('close', () => {
      // Fixed probes must leave no detached descendants after their host exits naturally.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
      if (child.pid) send({ type: 'child-closed', pid: child.pid });
    });
    return child;
  };
}

function driver(agent: string, cli: string): HostDriver {
  const hookLine =
    process.platform === 'win32' && agent === 'codex'
      ? windowsHookCommands(process.execPath, cli, agent)[0]!
      : hookCommand(process.execPath, cli, agent);
  const options = {
    hookLine,
    env: process.env,
    signal: controller.signal,
    spawn: trackedSpawn(agent),
  };
  return agent === 'codex' ? createCodexDriver(options) : createClaudeDriver(options);
}

interface Input {
  agent: string;
  version: string;
  cli: string;
  maxRequests: number;
  jobId: string;
  expected: { policySha256: string; hostVersion: string };
}

export async function runLiveProof(
  input: Input,
  suppliedDriver?: HostDriver,
): Promise<ReturnType<typeof projectHostResult>> {
  const policy = loadPolicy();
  if (policySha256(policy) !== input.expected.policySha256) throw new Error('preview-stale');
  const hosted = suppliedDriver ?? driver(input.agent, input.cli);
  const detected = await hosted.detect();
  if (!detected.available || detected.version !== input.expected.hostVersion)
    throw new Error('preview-stale');
  const made = createThrowawayRoot('stroq-console-proof-');
  const ledgerFile = join(stroqHome(), 'console', 'live-budgets', `${input.jobId}.json`);
  mkdirSync(join(stroqHome(), 'console', 'live-budgets'), { recursive: true, mode: 0o700 });
  try {
    const result = await verifyHost(
      { ...hosted, detect: async () => detected },
      {
        project: made.project,
        home: made.home,
        stroqHome: made.stroqHome,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        deadlineMs: 90_000,
      },
      {
        agent: input.agent,
        policy,
        stroqVersion: input.version,
        ledger: openLedger({ path: ledgerFile, limit: input.maxRequests }),
        maxRequests: input.maxRequests,
      },
    );
    const projected = projectHostResult(result);
    // An interrupted run can never replace a previous verified/failed result.
    if (!controller.signal.aborted) writeHostResult(stroqHome(), result);
    return projected;
  } finally {
    removeThrowawayRoot(made.root);
    try {
      unlinkSync(ledgerFile);
    } catch {
      /* May not have been created before cancellation. */
    }
  }
}

async function main(operation: string, input: Input) {
  if (operation === 'inspect') return inspectLive(input.version);
  if (!AGENTS.includes(input.agent) || (input.agent === 'codex') !== (process.platform === 'win32'))
    throw new Error('unsupported');
  if (operation === 'detect') {
    const found = await driver(input.agent, input.cli).detect();
    return {
      available: found.available,
      version: found.version !== null && VERSION.test(found.version) ? found.version : null,
    };
  }
  if (
    operation !== 'run' ||
    !Number.isInteger(input.maxRequests) ||
    input.maxRequests < 3 ||
    input.maxRequests > 6 ||
    !/^[a-f0-9-]{36}$/.test(input.jobId)
  )
    throw new Error('invalid-request');
  return runLiveProof(input);
}

if (process.argv[2] === '--stroq-console-live-engine' && process.send) {
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  process.once('disconnect', () => controller.abort());
  process.once('message', (message: { operation: string; input: Input }) => {
    void main(message.operation, message.input)
      .then(
        (result) => send({ type: 'result', result }),
        (error: unknown) =>
          send({
            type: 'error',
            error:
              error instanceof Error &&
              ['preview-stale', 'configuration-unreadable'].includes(error.message)
                ? error.message
                : 'live-check-failed',
          }),
      )
      .finally(() => {
        if (process.connected) process.disconnect();
      });
  });
}
