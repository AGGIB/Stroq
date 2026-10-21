// `stroq sent --counts`: what a run found, as numbers only, for a fleet script or a dashboard.
//
// It is built from the report by taking numbers and choosing labels out of tables in this
// code: dates as `YYYY-MM-DD`, agents and tiers by fixed names, services by the labels of
// `own-service.ts`. No key name, path, host, session id, command or hash is copied into it,
// so there is nothing for it to leak.
import { SERVICE_LABELS } from './own-service.js';
import { TIERS, type Tier } from './place.js';
import { stoppedTowardOthers, type Limit, type SentReport } from './report.js';
import type { Agent } from './sessions.js';

export const COUNTS_SCHEMA = 'stroq-sent-counts/1';

const AGENTS: readonly Agent[] = ['claude-code', 'codex', 'cursor'];

export type AgentCounts =
  { readonly sessions: number; readonly oldest: string | null } | { readonly status: 'not-read' };

export interface SentCounts {
  readonly schema: typeof COUNTS_SCHEMA;
  /** The day of the check, `YYYY-MM-DD`. */
  readonly checked: string;
  /** Stroq's version, when it reads as one; otherwise `unknown`. */
  readonly version: string;
  readonly synthetic?: true;
  readonly agents: Readonly<Record<Agent, AgentCounts>>;
  readonly keys_compared: number;
  /**
   * Keys per place, each under the most external place it reached. `model_only` is the old name of
   * `seen`, kept with the same number for one release.
   */
  readonly found: Readonly<Record<Tier, number>> & { readonly model_only: number };
  /**
   * Of `found.blocked`, the calls that would have gone to another company. That a call was
   * stopped is read from its result, which the call can write: worth a look.
   */
  readonly blocked_third_party: number;
  /** Found keys per service, by the labels of the service table. */
  readonly providers: Readonly<Record<string, number>>;
  /** Session files that could not be read. */
  readonly unreadable_files: number;
  /** True when nothing in this run was left unchecked: `not_checked` is empty. */
  readonly complete: boolean;
  readonly not_checked: readonly string[];
  /** What no run of the check sees, by fixed labels: the text report says each. */
  readonly limits: readonly Limit[];
}

const count = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const date = (iso: string | null): string | null =>
  iso === null || Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString().slice(0, 10);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function buildCounts(report: SentReport, version: string): SentCounts {
  const agents = Object.fromEntries(
    AGENTS.map((agent): [Agent, AgentCounts] => {
      if (agent === 'cursor' && report.notChecked.includes('cursor'))
        return [agent, { status: 'not-read' }];
      const seen = report.sessions.agents[agent];
      return [agent, { sessions: count(seen?.sessions ?? 0), oldest: date(seen?.oldest ?? null) }];
    }),
  ) as Record<Agent, AgentCounts>;
  const byTier = Object.fromEntries(
    TIERS.map((tier) => [tier, report.findings.filter((f) => f.tier === tier).length]),
  ) as Record<Tier, number>;
  const found = { ...byTier, model_only: byTier.seen };
  const providers: Record<string, number> = {};
  for (const f of report.findings) {
    const label = SERVICE_LABELS.has(f.provider) ? f.provider : 'Other';
    providers[label] = (providers[label] ?? 0) + 1;
  }
  const unreadable = count(report.unreadable) + count(report.keys.unreadable);
  return {
    schema: COUNTS_SCHEMA,
    checked: date(report.checked) ?? 'unknown',
    version: VERSION.test(version) ? version : 'unknown',
    ...(report.synthetic === true ? { synthetic: true as const } : {}),
    agents,
    keys_compared: count(report.keys.compared),
    found,
    blocked_third_party: stoppedTowardOthers(report),
    providers,
    unreadable_files: unreadable,
    complete: report.notChecked.length === 0 && unreadable === 0,
    not_checked: [...report.notChecked],
    limits: [...report.limits],
  };
}
