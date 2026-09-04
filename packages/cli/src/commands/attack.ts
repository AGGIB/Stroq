import { homedir } from 'node:os';
import { sep } from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport } from '../attack/report.js';
import { runAttack } from '../attack/run.js';
import type { Scenario } from '../attack/scenario.js';
import { SCENARIOS } from '../attack/scenarios/index.js';
import { loadPolicy, policySource } from '../engine-factory.js';

/** `--only 05` or `--only 05-roguepilot-schema-url`. */
function select(only: string | undefined): readonly Scenario[] {
  if (only === undefined) return SCENARIOS;
  return SCENARIOS.filter((s) => s.id === only || s.id.startsWith(`${only}-`));
}

/**
 * Shortens a path under the user's home directory to `~/...`, for display only (the
 * report's `policy` field) — never used for file access, so it can't affect where the
 * policy is actually loaded from. Leaves `default` and paths outside home untouched.
 */
export function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** Replays the recorded incident scenarios against the active policy; exit 1 if any misbehaves. */
export async function runAttackCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean', default: false }, only: { type: 'string' } },
  });
  const selected = select(values.only);
  if (selected.length === 0) {
    const ids = SCENARIOS.map((s) => s.id).join(', ');
    process.stdout.write(`no scenario matches "${values.only}"; ids: ${ids}\n`);
    return 1;
  }
  const report = await runAttack(selected, loadPolicy(), displayPath(policySource()));
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.ok ? 0 : 1;
}
