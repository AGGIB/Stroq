import { createHash } from 'node:crypto';
import { stableStringify } from '../audit/audit-log.js';

/**
 * The name of one operation, as `stroq permit extend` takes it. An escalation is signed for
 * exactly one fingerprint. Only representations known to mean the same operation may
 * share one; uncertainty costs another approval instead of granting a different operation.
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
 * Shell whitespace is syntax: a newline ends a comment and quoted spaces change an argument.
 * Hash the exact command bytes. This deliberately forgoes the plan's whitespace normalization:
 * another approval for differently spaced text is safer than one approval for different commands.
 */
export function shellTarget(command: string): string {
  return sha256(command);
}

/** Any other call (a fetch, a task, a note) is named by the digest of its whole input. */
export const genericTarget = (toolInput: unknown): string => sha256(stableStringify(toolInput));
