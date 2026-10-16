import type { ActionClass } from '../types.js';

/**
 * The classes no task scope, no escalation and no policy file can make allowed. They are
 * the ways an instruction the agent read turns into harm that a person's approval of a task
 * could never have covered: a known secret on its way out, a decoy file touched, Stroq's own
 * configuration or a repository hook rewritten, an encoded command run, an action copied
 * from text the session had already flagged.
 *
 * `origin.untrusted` is absent on purpose, including when it is only there because the
 * session's provenance is incomplete (see `originClasses`). The set holds evidence: a record
 * that Stroq flagged what the action copies. Incompleteness is the lack of it, and a policy
 * ask a task's owner can lift for one call (`stroq permit extend`) is the right answer to a
 * lack of evidence; a class nothing can lift would end a long task at its first unrecorded
 * package with no way on.
 *
 * A constant in CODE, on purpose. Everything else Stroq decides is first-match over a YAML
 * file that its user can replace, and a rule that can be edited is not a floor. Typed as
 * `ActionClass`, so that a class renamed or removed breaks the build here instead of
 * quietly leaving a hole.
 */
export const HARD_CLASSES: readonly ActionClass[] = Object.freeze<ActionClass[]>([
  'secret.egress',
  'secret.unscannable',
  'fs.canary',
  'config.self',
  'config.git_exec',
  'shell.exec_encoded',
  'origin.suspect',
]);

export const isHardClass = (name: ActionClass): boolean => HARD_CLASSES.includes(name);

/** The first hard class (in the order of the set) among a call's classes, or null. */
export function firstHardClass(classes: readonly ActionClass[]): ActionClass | null {
  return HARD_CLASSES.find((name) => classes.includes(name)) ?? null;
}
