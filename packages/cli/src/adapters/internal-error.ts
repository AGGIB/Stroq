// What a hook says when Stroq itself failed and the call is refused (fail-closed).
//
// One cause has a remedy the person can act on: Stroq's own folder is closed to the hook. A sandbox around
// the agent (Agent Safehouse, a `sandbox-exec` profile, a container with the home left out) runs the hook
// inside it, and one that does not grant the Stroq home leaves the hook unable to read its policy or keep
// its state. The call is refused all the same; the reason says which folder and what to grant.
import { isAbsolute, relative } from 'node:path';
import { stroqHome } from '../paths.js';

const CLOSED = new Set(['EPERM', 'EACCES']);

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Whether `err` is the Stroq home, or a path in it, refused to this process. */
export function isClosedHome(err: unknown, home: string): boolean {
  if (err === null || typeof err !== 'object') return false;
  const { code, path, message } = err as { code?: unknown; path?: unknown; message?: unknown };
  if (typeof code !== 'string' || !CLOSED.has(code)) return false;
  if (typeof path === 'string') return inside(path, home);
  return typeof message === 'string' && message.includes(home);
}

/** The reason for a call refused because Stroq failed: the error, and the remedy when its folder is closed. */
export function internalErrorReason(err: unknown, home: string = stroqHome()): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!isClosedHome(err, home)) return `Stroq internal error (fail-closed): ${message}`;
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return (
    `Stroq internal error (fail-closed): ${sentence} Stroq cannot use its own folder, ${home}. ` +
    'If the agent runs in a sandbox, give that folder read and write access in it.'
  );
}
