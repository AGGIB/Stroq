import type { Scenario } from '../attack/scenario.js';
import { SCENARIOS } from '../attack/scenarios/index.js';
import { loadAsi } from './asi.js';
import { loadAtlas } from './atlas.js';
import { loadScope } from './scope.js';

/**
 * `covered`: at least one scenario tags the technique and `scope.json` records no
 * limitation. `partial`: a scenario tags it and a limitation is recorded. `not_covered`:
 * no scenario tags it, whatever `scope.json` says — a stated limitation on an
 * untagged technique is a claim about the surface, not evidence the corpus proves it.
 */
export type CoverageStatus = 'covered' | 'partial' | 'not_covered';

export interface TechniqueCoverage {
  readonly id: string;
  readonly name: string;
  readonly status: CoverageStatus;
  readonly limitation: string | null;
  readonly scenarios: readonly string[];
}

export interface AsiCoverage {
  readonly id: string;
  readonly name: string;
  readonly scenarios: readonly string[];
}

export interface CoverageReport {
  readonly version: 1;
  readonly atlasRelease: string;
  readonly asiEdition: string;
  readonly scenarios: {
    readonly total: number;
    readonly documented: number;
    readonly synthetic: number;
  };
  readonly techniques: readonly TechniqueCoverage[];
  readonly summary: {
    readonly inScope: number;
    readonly covered: number;
    readonly partial: number;
    readonly notCovered: number;
  };
  readonly asi: readonly AsiCoverage[];
}

/**
 * Builds an id -> scenario-ids index in one pass over `SCENARIOS`, rather than
 * filtering the corpus once per technique or risk (which is what a naive per-row
 * `SCENARIOS.filter(...)` would do across ~60 in-scope techniques).
 */
function scenarioIndex(scenarios: readonly Scenario[], tagsOf: (s: Scenario) => readonly string[]): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const scenario of scenarios) {
    for (const tag of tagsOf(scenario)) {
      const ids = index.get(tag);
      if (ids) ids.push(scenario.id);
      else index.set(tag, [scenario.id]);
    }
  }
  return index;
}

function statusOf(taggedBy: readonly string[], limitation: string | null): CoverageStatus {
  if (taggedBy.length === 0) return 'not_covered';
  return limitation === null ? 'covered' : 'partial';
}

/**
 * Computes the control mapping fresh from `loadAtlas`, `loadScope`, `loadAsi` and
 * `SCENARIOS` every call — every count here is derived, never carried as a literal,
 * so the report cannot drift from the data it reads.
 */
export function buildCoverage(): CoverageReport {
  const atlas = loadAtlas();
  const scope = loadScope();
  const asi = loadAsi();

  const nameById = new Map(atlas.techniques.map((t) => [t.id, t.name]));
  const byAtlasId = scenarioIndex(SCENARIOS, (s) => s.atlas);
  const byAsiId = scenarioIndex(SCENARIOS, (s) => s.asi);

  const techniques: readonly TechniqueCoverage[] = scope.inScope.map((t) => {
    const taggedBy = byAtlasId.get(t.id) ?? [];
    const name = nameById.get(t.id);
    if (name === undefined) {
      throw new Error(`scope.json declares ${t.id} in scope but it is absent from the vendored ATLAS denominator`);
    }
    return {
      id: t.id,
      name,
      status: statusOf(taggedBy, t.limitation),
      limitation: t.limitation,
      scenarios: taggedBy,
    };
  });

  const summary = techniques.reduce(
    (acc, t) => {
      if (t.status === 'covered') return { ...acc, covered: acc.covered + 1 };
      if (t.status === 'partial') return { ...acc, partial: acc.partial + 1 };
      return { ...acc, notCovered: acc.notCovered + 1 };
    },
    { inScope: techniques.length, covered: 0, partial: 0, notCovered: 0 },
  );

  const documented = SCENARIOS.filter((s) => s.incident !== null).length;
  const synthetic = SCENARIOS.length - documented;

  const asiCoverage: readonly AsiCoverage[] = asi.risks.map((r) => ({
    id: r.id,
    name: r.name,
    scenarios: byAsiId.get(r.id) ?? [],
  }));

  return {
    version: 1,
    atlasRelease: atlas.release,
    asiEdition: asi.edition,
    scenarios: { total: SCENARIOS.length, documented, synthetic },
    techniques,
    summary,
    asi: asiCoverage,
  };
}

const ID_WIDTH = 16;
const STATUS_WIDTH = 11;
const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'covered',
  partial: 'partial',
  not_covered: 'not covered',
};

function techniqueLine(t: TechniqueCoverage): string {
  const status = STATUS_LABEL[t.status].padEnd(STATUS_WIDTH);
  const evidence = t.scenarios.length > 0 ? t.scenarios.join(', ') : '-';
  const first = `${t.id.padEnd(ID_WIDTH)} ${status} ${t.name} (${evidence})`;
  return t.limitation === null ? first : `${first}\n    limitation: ${t.limitation}`;
}

/**
 * Why a currently-unclaimed ASI risk has no scenario, in Stroq's own terms — not
 * derived from `asi.json` (a verbatim OWASP transcript with no room for Stroq's
 * judgment) or from the corpus, since neither records this reasoning anywhere.
 * ASI07/ASI08 are a claim about Stroq's shape (one agent's tool calls, never a
 * multi-agent system); ASI09 is a claim about the corpus's shape (it replays hook
 * events and never models a human approval step); ASI10 is a to-do, not a claim —
 * simply not yet exercised. Keyed by id and consulted only for a risk `asiLine`
 * already finds unclaimed, so a future scenario that starts tagging one of these
 * ids just stops matching here and falls back to the ordinary evidence line.
 */
const ASI_UNCLAIMED_REASON: Readonly<Record<string, string>> = {
  ASI07: "structurally out of reach: needs a multi-agent system, and Stroq sits on one agent's tool calls",
  ASI08: "structurally out of reach: needs a multi-agent system, and Stroq sits on one agent's tool calls",
  ASI09:
    'out of observation: the attack suite replays hook events and never models a human approval step, so no scenario can honestly exercise it',
  ASI10: 'not yet exercised: a gap in the corpus, not a statement about what Stroq can see',
};

function asiLine(risk: AsiCoverage): string {
  if (risk.scenarios.length > 0) return `${risk.id.padEnd(6)} ${risk.name} — scenarios: ${risk.scenarios.join(', ')}`;
  const reason = ASI_UNCLAIMED_REASON[risk.id];
  return `${risk.id.padEnd(6)} ${risk.name} — not claimed by any scenario${reason ? ` (${reason})` : ''}`;
}

/**
 * Not a ratio, on purpose: the header carries only the depth number (scenarios
 * shipped, split into documented and synthetic) and the two taxonomy pins. Anyone
 * who wants a percentage can compute it from `report.summary`; this function
 * never does.
 */
function headerLine(report: CoverageReport): string {
  const { total, documented, synthetic } = report.scenarios;
  return `stroq coverage — ${total} scenarios (${documented} documented, ${synthetic} synthetic) · ATLAS ${report.atlasRelease} · OWASP ASI ${report.asiEdition}`;
}

function summaryLine(summary: CoverageReport['summary']): string {
  return `in scope: ${summary.inScope} techniques — ${summary.covered} covered, ${summary.partial} partial, ${summary.notCovered} not covered`;
}

/**
 * Renders the full table: every in-scope technique appears in one list — covered,
 * partial and not-covered alike — and the summary sentence at the end names all
 * three counts together, so an uncovered row is never something a reader can skip
 * past in a section of its own.
 */
export function formatCoverage(report: CoverageReport): string {
  const lines = [
    headerLine(report),
    '',
    ...report.techniques.map(techniqueLine),
    '',
    summaryLine(report.summary),
    '',
    'OWASP ASI 2026:',
    ...report.asi.map(asiLine),
  ];
  return `${lines.join('\n')}\n`;
}

const NAVIGATOR_COLOR: Record<CoverageStatus, string> = {
  covered: '#C8E6C9',
  partial: '#FFE0B2',
  not_covered: '#EEEEEE',
};

/**
 * What goes in a technique's Navigator comment, so the layer reads honestly a year
 * from now with no other document open beside it: the stated limitation when one
 * exists (whether the row is covered by a scenario or not); otherwise, for a row no
 * scenario tags, that absence said plainly rather than left blank.
 */
function navigatorComment(t: TechniqueCoverage): string {
  if (t.limitation !== null) return t.limitation;
  return t.scenarios.length > 0
    ? `covered, no stated limitation — scenarios: ${t.scenarios.join(', ')}`
    : 'no scenario covers this yet';
}

/**
 * Shape copied from MITRE's own ATLAS Navigator layers, not invented: `domain`
 * `atlas-atlas`, `versions.layer` `4.3`, a `metadata` entry naming the ATLAS data
 * version. The per-technique `tactic` field is omitted — ATLAS v6 carries no
 * technique -> tactic edge, the v4.5 layer format documents the field as optional,
 * and the Navigator resolves placement from the matrix it loads.
 */
export function toNavigatorLayer(report: CoverageReport): Record<string, unknown> {
  return {
    name: 'Stroq control mapping',
    versions: { layer: '4.3', navigator: '4.6.4' },
    domain: 'atlas-atlas',
    description: `What Stroq's hook-based action firewall addresses against MITRE ATLAS ${report.atlasRelease}, derived from its attack corpus: ${report.scenarios.total} scenarios (${report.scenarios.documented} documented, ${report.scenarios.synthetic} synthetic).`,
    sorting: 0,
    layout: { layout: 'side', showID: true, showName: true },
    hideDisabled: false,
    techniques: report.techniques.map((t) => ({
      techniqueID: t.id,
      color: NAVIGATOR_COLOR[t.status],
      comment: navigatorComment(t),
      enabled: true,
      showSubtechniques: false,
    })),
    gradient: { colors: [NAVIGATOR_COLOR.not_covered, NAVIGATOR_COLOR.covered], minValue: 0, maxValue: 1 },
    legendItems: [
      { label: 'covered', color: NAVIGATOR_COLOR.covered },
      { label: 'partial', color: NAVIGATOR_COLOR.partial },
      { label: 'not covered', color: NAVIGATOR_COLOR.not_covered },
    ],
    metadata: [
      { name: 'atlas_data_version', value: report.atlasRelease },
      { name: 'asi_edition', value: report.asiEdition },
    ],
    links: [],
    showTacticRowBackground: false,
    tacticRowBackground: '#dddddd',
    selectTechniquesAcrossTactics: true,
    selectSubtechniquesWithParent: false,
  };
}
