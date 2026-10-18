import type { Scenario } from '../attack/scenario.js';
import { SCENARIOS } from '../attack/scenarios/index.js';
import {
  ATTACK_CHANNELS,
  ATTACK_HOSTS,
  HOST_CHANNELS,
  hostStepSupport,
  type AttackHost,
} from './channels.js';

export interface HostStepAccounting {
  readonly host: AttackHost;
  readonly totalScenarios: number;
  readonly totalSteps: number;
  readonly supportedSteps: number;
  readonly unsupportedSteps: number;
  readonly unsupportedScenarios: number;
  readonly unsupportedStepList: readonly {
    readonly scenarioId: string;
    readonly step: number;
    readonly phase: 'pre' | 'post';
    readonly tool: string;
    readonly channel: string;
    readonly status: string;
  }[];
}

export function computeHostStepAccounting(
  host: AttackHost,
  scenarios: readonly Scenario[] = SCENARIOS,
): HostStepAccounting {
  let totalSteps = 0;
  let supportedSteps = 0;
  let unsupportedScenarios = 0;
  const unsupportedStepList: {
    readonly scenarioId: string;
    readonly step: number;
    readonly phase: 'pre' | 'post';
    readonly tool: string;
    readonly channel: string;
    readonly status: string;
  }[] = [];

  for (const scenario of scenarios) {
    let scenarioHasUnsupported = false;
    scenario.steps.forEach((step, idx) => {
      totalSteps += 1;
      const phase = step.event.hook_event_name === 'PreToolUse' ? 'pre' : 'post';
      const tool = String(step.event.tool_name);
      const support = hostStepSupport(host, phase, tool);
      if (support.supported) {
        supportedSteps += 1;
      } else {
        scenarioHasUnsupported = true;
        unsupportedStepList.push({
          scenarioId: scenario.id,
          step: idx + 1,
          phase,
          tool,
          channel: support.channel,
          status: support.cell.status,
        });
      }
    });
    if (scenarioHasUnsupported) unsupportedScenarios += 1;
  }

  return {
    host,
    totalScenarios: scenarios.length,
    totalSteps,
    supportedSteps,
    unsupportedSteps: totalSteps - supportedSteps,
    unsupportedScenarios,
    unsupportedStepList,
  };
}

/**
 * Renders `docs/HOSTS.md` from `HOST_CHANNELS` and the 36-scenario attack corpus.
 * Checked in CI by `pnpm check:reports` (`scripts/generate-reports.ts --check`).
 */
export function formatHostsMarkdown(scenarios: readonly Scenario[] = SCENARIOS): string {
  const lines: string[] = [];
  lines.push(
    '<!--',
    '  GENERATED FILE. Do not hand-edit.',
    "  Produced by `pnpm generate:reports` from `stroq attack --host <id>`'s channel table.",
    '  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if',
    '  this file and the channel table in `packages/cli/src/hosts/channels.ts` disagree.',
    '-->',
    '',
    '# Host Channel Coverage',
    '',
    'Which scenario step channels each host actually sends to Stroq, generated from [`packages/cli/src/hosts/channels.ts`](../packages/cli/src/hosts/channels.ts).',
    '',
    '`stroq attack` replays the 36-scenario corpus in-process using Claude Code hook events. When you pass `--host <id>`, each step is checked against the target host’s row below before the engine runs it:',
    '',
    '- **`seen`** — the host emits a hook event for this channel and enforces or records the step as documented.',
    '- **`partial`** — the host sends this channel to Stroq (so `stroq attack --host <id>` replays the step), with host-specific wire or decision limits documented in [`docs/AGENTS.md`](./AGENTS.md) (for example, `ask` collapsed to `deny`, path-only `apply_patch` inspection, or silent post-tool taint).',
    '- **`not seen`** — the host never sends this channel to Stroq. Under `stroq attack --host <id>`, any step on this channel is reported as `unsupported`, counted apart from `blocked`, `asked` and `passed`, never counted as a protection, and fails the exit code (`1`).',
    '- **`unknown`** — not yet checked against the host; treated as `unsupported` (`not seen`) so an untested channel is never counted as a protection.',
    '',
    '## Channel matrix',
    '',
    `| Host | \`--host\` | ${ATTACK_CHANNELS.join(' | ')} | Supported steps | Unsupported scenarios |`,
    `| :--- | :--- | ${ATTACK_CHANNELS.map(() => ':---').join(' | ')} | ---: | ---: |`,
  );

  for (const host of ATTACK_HOSTS) {
    const entry = HOST_CHANNELS[host];
    const acc = computeHostStepAccounting(host, scenarios);
    const cells = ATTACK_CHANNELS.map((ch) => `\`${entry.channels[ch].status}\``).join(' | ');
    lines.push(
      `| [${entry.label}](./AGENTS.md#${entry.agentsAnchor}) | \`${entry.id}\` | ${cells} | ${acc.supportedSteps} / ${acc.totalSteps} | ${acc.unsupportedScenarios} / ${acc.totalScenarios} |`,
    );
  }

  lines.push('', '## Evidence by host', '');

  for (const host of ATTACK_HOSTS) {
    const entry = HOST_CHANNELS[host];
    const acc = computeHostStepAccounting(host, scenarios);
    lines.push(
      `### ${entry.label} (\`${entry.id}\`)`,
      '',
      `Adapter reference: [\`docs/AGENTS.md#${entry.agentsAnchor}\`](./AGENTS.md#${entry.agentsAnchor})`,
      '',
      '| Channel | Status | Evidence |',
      '| :--- | :--- | :--- |',
    );
    for (const ch of ATTACK_CHANNELS) {
      const cell = entry.channels[ch];
      lines.push(`| ${ch} | \`${cell.status}\` | ${cell.evidence} |`);
    }
    lines.push('');
    if (acc.unsupportedStepList.length === 0) {
      lines.push(
        `Unsupported steps in \`stroq attack --host ${entry.id}\`: none (${acc.supportedSteps} / ${acc.totalSteps} steps supported across ${acc.totalScenarios} scenarios).`,
        '',
      );
    } else {
      const items = acc.unsupportedStepList
        .map((u) => `\`${u.scenarioId}\` step ${u.step} (\`${u.phase} ${u.tool}\`, ${u.channel})`)
        .join(', ');
      lines.push(
        `Unsupported steps in \`stroq attack --host ${entry.id}\` (${acc.unsupportedSteps} of ${acc.totalSteps} steps across ${acc.unsupportedScenarios} of ${acc.totalScenarios} scenarios): ${items}.`,
        '',
      );
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
