// What a run proves, and what it does not: the way in.
//
// A host is asked to run an inert command. The model's stream says it did; that is the model's own
// account and counts for little. What counts is read afterwards, from places the model does not write:
//
//   E1  the stream has a shell call whose command is the probe's command: the command was issued, and
//       not some other command that happens to carry the nonce;
//   E2  the hook's own audit log, for this request, has one entry for that command and no other, with the
//       decision (effect and rule) the policy was seen to give in process: the hook judged it;
//   E3  the file on the disk is as the decision says: absent for a deny, there with the nonce for an
//       allow: the host did what the hook said;
//   E4  the words the host gave back for the call carry Stroq's own deny wording: the stop came from the
//       hook, and not from the host's own permission rules.
//
// The facts are read in `facts.ts`, the marks that follow from them are given in `marks.ts`, and the
// rules by which a run can be read at all are in `run-problem.ts`. This module is where the rest of the
// code finds them.
export {
  AUDIT_SUMMARY_CHARS,
  SHELL_TOOL,
  WITHHELD_SUMMARY,
  auditSummaryOf,
  normalizeCommand,
} from './command.js';
export { type AuditFinding } from './audit-finding.js';
export { isWellFormedRun, runProblem, type RunProblem } from './run-problem.js';
export {
  DENY_WORDING,
  gatherEvidence,
  type Evidence,
  type EvidenceInput,
  type Issued,
} from './facts.js';
export {
  CONTROL_CHECK_ORDER,
  PROBE_CHECK_ORDER,
  markControl,
  markProbe,
  type ProbeOutcome,
} from './marks.js';
