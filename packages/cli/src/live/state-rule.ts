// The one rule that turns the marks of the probes into the state of a host.
//
// It is used twice and has to be the same both times: by `verifyHost`, to say what a run came to, and by
// the reader of a stored result, to refuse a file whose state is not what its own probes come to. A file
// that was edited to say `verified` over probes that did not earn it must not read as a result.
//
// A host is verified when the allow probe passed, and a deny probe passed, and the control run of that
// deny showed it armed: the same command, under a hook that allows everything, was run by the host and
// left its file. Without the control a deny that "did not happen" says nothing: the host's own permission
// rules, a command that cannot run in this directory, or a model that never really ran it would all
// leave the file absent, whatever the hook said.
import type { LiveOutcome, ProbeKind, ProbeMark } from './types.js';

/** What the id of a control run ends with: `deny:control` is the control of `deny`. */
export const CONTROL_SUFFIX = ':control';

export const controlIdOf = (id: string): string => `${id}${CONTROL_SUFFIX}`;
const isControl = (probe: { readonly id: string }): boolean => probe.id.endsWith(CONTROL_SUFFIX);

/** What the rule looks at in a probe, whether it is a row of a run or a probe of a stored result. */
export interface MarkedProbe {
  readonly id: string;
  readonly kind: ProbeKind;
  readonly mark: ProbeMark;
}

/** Marks that count as the check not having been tried. */
const NOT_TRIED: readonly ProbeMark[] = ['not-attempted', 'skipped'];

/**
 * The state of a host from all its probes, the control runs among them:
 *
 * - failed when any probe failed;
 * - verified when the allow passed and a deny passed whose control (the probe of the same kind with the
 *   id of the deny and `:control`) passed too;
 * - not attempted when no probe was tried (all were skipped or not attempted), and inconclusive otherwise.
 */
export function overallState(probes: readonly MarkedProbe[]): LiveOutcome {
  if (probes.some((probe) => probe.mark === 'failed')) return 'failed';
  const passed = (probe: MarkedProbe): boolean => probe.mark === 'passed';
  const real = probes.filter((probe) => !isControl(probe));
  const armed = (deny: MarkedProbe): boolean =>
    probes.some(
      (control) =>
        control.id === controlIdOf(deny.id) && control.kind === deny.kind && passed(control),
    );
  const allowPassed = real.some((probe) => probe.kind === 'allow' && passed(probe));
  const armedDeny = real.some((probe) => probe.kind !== 'allow' && passed(probe) && armed(probe));
  if (allowPassed && armedDeny) return 'verified';
  return probes.every((probe) => NOT_TRIED.includes(probe.mark)) ? 'not-attempted' : 'inconclusive';
}
