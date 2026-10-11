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
//
// And the stop has to have been the hook's. A host that ignores the deny of a hook and has permission rules
// of its own that refuse the command looks the same as one that honours it, and a control that was started
// a little differently (a driver that lets its no-op hook say "allow" skips the host's permission step)
// arms a command those rules had stopped. The host's error text for the call is what tells them apart: the
// words of Stroq's own deny (E4). A deny whose stop was worded otherwise, or whose words are not known,
// does not make a verified, however well its control did.
import type { LiveOutcome, ProbeKind, ProbeMark } from './types.js';

/** What the id of a control run ends with: `deny:control` is the control of `deny`. */
export const CONTROL_SUFFIX = ':control';

export const controlIdOf = (id: string): string => `${id}${CONTROL_SUFFIX}`;
export const isControlId = (id: string): boolean => id.endsWith(CONTROL_SUFFIX);
const isControl = (probe: { readonly id: string }): boolean => isControlId(probe.id);

/** What the rule looks at in a probe, whether it is a row of a run or a probe of a stored result. */
export interface MarkedProbe {
  readonly id: string;
  readonly kind: ProbeKind;
  readonly mark: ProbeMark;
  /**
   * Whether the host passed on the words of the hook for the stop (evidence E4). Only a deny has them to
   * pass on; it is true for the one that did, and false or null for any other.
   */
  readonly e4?: boolean | null | undefined;
}

/** Marks that count as the check not having been tried. */
const NOT_TRIED: readonly ProbeMark[] = ['not-attempted', 'skipped'];

/**
 * The state of a host from all its probes, the control runs among them:
 *
 * - failed when any probe failed;
 * - verified when the allow passed and a deny passed in the words of the hook (E4) whose control (the probe
 *   of the same kind with the id of the deny and `:control`) passed too;
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
  const stoppedByTheHook = (deny: MarkedProbe): boolean =>
    deny.kind !== 'allow' && passed(deny) && deny.e4 === true;
  const allowPassed = real.some((probe) => probe.kind === 'allow' && passed(probe));
  const armedDeny = real.some((probe) => stoppedByTheHook(probe) && armed(probe));
  if (allowPassed && armedDeny) return 'verified';
  return probes.every((probe) => NOT_TRIED.includes(probe.mark)) ? 'not-attempted' : 'inconclusive';
}
