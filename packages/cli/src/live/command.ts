// The command of a probe, as a model issues it and as the audit log keeps it.
//
// A probe is tied to its command, and not only to its nonce: the nonce shows that a call was made for
// this request, and the command shows that the call was the one asked for. Two places hold the command,
// and each has its own spelling of it. The stream has whatever the model typed, which may differ from the
// probe in the white space; the audit log has the command redacted and cut. These are the rules for
// comparing each with the probe.
import { redact } from '@stroq/core';

/**
 * The tool the probes are run with, as a host names it in its stream. A driver puts the shell tool of its
 * host under this name, and a call made with any other tool is not a probe being run.
 */
export const SHELL_TOOL = 'Bash';

/**
 * How many characters of a summary the audit log keeps. It is `MAX_SUMMARY` in core's `audit-log.ts`,
 * which does not export it; `evidence-command.test.ts` records a command longer than this through the
 * real engine and log, so a change there fails there.
 */
export const AUDIT_SUMMARY_CHARS = 300;

/**
 * What the engine writes as the summary of a call when its secret index fails (`safeSummary` in core's
 * `engine.ts`). The entry is there, and says nothing of what the call was. The same test records it from
 * the real engine, so that this and the engine cannot drift apart.
 */
export const WITHHELD_SUMMARY = '[REDACTED:secret-index-unavailable]';

/**
 * A command as it is compared: no white space at either end, and every run of it one space. A host or a
 * model may change how a command is spaced; it cannot change what it is by that.
 */
export const normalizeCommand = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * The summary the audit log records for a command the hook judged: the command redacted as the log
 * redacts it, and cut where the log cuts it. For the egress probe the redaction takes the made-up key
 * out, and so what is compared with the log is the redacted command with the redacted summary.
 */
export const auditSummaryOf = (command: string): string =>
  redact(command).slice(0, AUDIT_SUMMARY_CHARS);
