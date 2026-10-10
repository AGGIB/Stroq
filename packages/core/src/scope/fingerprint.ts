import { createHash } from 'node:crypto';
import { stableStringify } from '../audit/audit-log.js';

/**
 * The name of one operation, as `stroq permit extend` takes it. An escalation is signed for
 * exactly one fingerprint, so the fingerprint has to be the same for the same operation
 * however it is spelled on the way in, and different for any other.
 */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function fingerprintOf(tool: string, kind: string, target: string): string {
  return sha256(stableStringify({ tool, kind, target }));
}

/** A file is named by where it really is, so a link cannot make one file two operations. */
export const fileTarget = (path: string, real?: string): string => real ?? path;

/** An MCP call is named by server, tool and the digest of its arguments, whatever order they came in. */
export const mcpTarget = (server: string, tool: string, args: unknown): string =>
  `${server}/${tool}#${sha256(stableStringify(args))}`;

/**
 * A command is named by the digest of its text with runs of ASCII whitespace made single
 * spaces. ASCII only: a no-break space is part of a word to a shell, not a gap between two,
 * and merging them would let an approval for one command stand for another. Whitespace
 * inside quotes is collapsed too, which is the cost of not reading shell here.
 */
export function shellTarget(command: string): string {
  return sha256(command.replace(/[ \t\r\n\v\f]+/g, ' ').replace(/^ | $/g, ''));
}
