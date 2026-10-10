// How the marks of the probes become the result of a host.
//
// A host is verified when the allow passed and a deny was stopped AND that deny's control run showed it
// armed (the same command, under a hook that allows everything, ran and left its file). It has failed
// when any probe failed. Everything between is inconclusive, and a run in which nothing was sent is not
// attempted. The rule is `state-rule.ts`, the one the reader of a stored result applies too; here the
// rows are the real runs and their controls, after the controls have had their say, so that a pass that
// a control could not confirm is not counted.
import type { HostCapability } from '../hosts/capabilities.js';
import { plainText, type ProbeOutcome } from './evidence.js';
import { overallState as stateOf } from './state-rule.js';
import { REASONS, type LiveOutcome, type ProbeKind, type ProbeResult } from './types.js';

/** One probe of a run: what it is, and how it came out. */
export interface Row {
  readonly id: string;
  readonly kind: ProbeKind;
  readonly outcome: ProbeOutcome;
}

/** A probe that was not run: nothing was seen of it, and there is nothing to say it was not seen. */
export function nothing(
  mark: 'skipped' | 'not-attempted',
  reason: string,
  detail: string,
): ProbeOutcome {
  return {
    mark,
    reason,
    detail: plainText(detail),
    evidence: { E1: null, E2: null, E3: null, E4: null },
  };
}

/**
 * A deny that was stopped is a result only if the host would have run the command had the hook let it.
 * The control run is the same command with a hook that allows everything. If its file appeared, the
 * probe is armed and the pass stands. If it did not, the host would not have run the command whatever
 * the hook said, and the missing file in the real run was no proof. If there is no control run at all,
 * the pass is not confirmed either: when one was asked for and did not happen (it was not issued, could
 * not tell, was not attempted) that is `control-inconclusive`, and when none was asked for it is
 * `deny-not-proven-armed`. The evidence of the real run is kept as it was found.
 */
export function downgradeUnarmed(
  row: Row,
  control: ProbeOutcome | undefined,
  controlAsked: boolean = true,
): Row {
  if (row.kind === 'allow' || row.outcome.mark !== 'passed') return row;
  if (control?.mark === 'passed') return row;
  const unarmed = control?.reason === REASONS.probeNotArmed;
  const unasked = !unarmed && !controlAsked;
  const outcome: ProbeOutcome = {
    mark: 'inconclusive',
    reason: unarmed
      ? REASONS.probeNotArmed
      : unasked
        ? REASONS.denyNotProvenArmed
        : REASONS.controlInconclusive,
    detail: plainText(
      unarmed
        ? 'with a hook that allows everything the control run left no file, so the host does not run this command and a missing file proves nothing'
        : unasked
          ? 'no control run was made, so it is not known that the host would have run this command had the hook let it'
          : control === undefined
            ? 'no control run confirmed that the probe is armed'
            : `the control run did not confirm that the probe is armed (${control.reason})`,
    ),
    evidence: row.outcome.evidence,
  };
  return { ...row, outcome };
}

/**
 * The state of a host from the rows of a run: its probes and their controls, which are rows of their
 * own (the id of the probe and `:control`). See `state-rule.ts` for the rule.
 */
export function overallState(rows: readonly Row[]): LiveOutcome {
  return stateOf(rows.map((row) => ({ id: row.id, kind: row.kind, mark: row.outcome.mark })));
}

export function toProbeResult(row: Row): ProbeResult {
  return {
    id: row.id,
    kind: row.kind,
    mark: row.outcome.mark,
    reason: row.outcome.reason,
    ...(row.outcome.detail === undefined ? {} : { detail: row.outcome.detail }),
    evidence: row.outcome.evidence,
  };
}

/** Most a stored result can hold. */
const MAX_CAVEATS = 16;
const MAX_CAVEAT_CHARS = 120;

/**
 * What the result does not show, as short notes: what the host table says of this host, what the driver
 * said when it looked for the host, that no control was run, and the denies that were stopped without the
 * host passing on the hook's own words (which a host's own permission rules could have produced).
 */
export function caveatsFor(args: {
  readonly capabilities: HostCapability | undefined;
  readonly note: string | undefined;
  readonly control: boolean;
  readonly rows: readonly Row[];
}): string[] {
  const stopped = args.rows.filter((row) => row.kind !== 'allow' && row.outcome.mark === 'passed');
  const all = [
    ...(args.capabilities?.caveats ?? []),
    ...(args.note === undefined ? [] : [args.note]),
    ...(stopped.length > 0 && !args.control ? ['no-control-run'] : []),
    ...stopped
      .filter((row) => row.outcome.evidence.E4 === false)
      .map((row) => `deny-text-not-seen:${row.id}`),
  ]
    .map((caveat) => plainText(caveat, MAX_CAVEAT_CHARS))
    .filter((caveat) => caveat !== '');
  return [...new Set(all)].slice(0, MAX_CAVEATS);
}
