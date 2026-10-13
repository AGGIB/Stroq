import { splitTopQuoted } from './shell-top-level.js';
import { resolve } from './shell-words.js';

const TRANSFERS = new Set(['scp', 'rsync', 'sftp', 'rclone']);
const GIT_TRANSFERS = new Set(['fetch', 'clone', 'ls-remote', 'push', 'pull']);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);
const SCP = /(?:^|[\s"'`])((?:[\w.-]+@)?([\w][\w.-]*):(?!\/\/)[^\s"'`;|&<>()]+)/g;

function isTransfer(segment: string): boolean {
  const found = resolve(segment);
  if (found === null) return false;
  if (TRANSFERS.has(found.name)) return true;
  if (found.name !== 'git') return false;
  const args = found.args.map((word) => word.value);
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] as string;
    if (word === '--') return GIT_TRANSFERS.has(args[at + 1] ?? '');
    if (!word.startsWith('-')) return GIT_TRANSFERS.has(word);
    if (GIT_VALUE_OPTIONS.has(word)) at += 1;
  }
  return false;
}

/** Task-only address heuristic. Dotted module names alone never establish a remote. */
export function* scpRemotes(command: string): Generator<{ url: string; host: string }> {
  for (const segment of splitTopQuoted(command)) {
    let transfer: boolean | undefined;
    for (const [, target, host] of segment.matchAll(SCP)) {
      if (target === undefined || host === undefined) continue;
      const user = target.includes('@');
      // Existing SSH_TARGET already keeps this legacy user@dotted-host spelling.
      if (user && /^[\w-]+(?:\.[\w-]+)+$/.test(host)) continue;
      if (!user && (host.length === 1 || !(transfer ??= isTransfer(segment)))) continue;
      yield { url: target, host: host.toLowerCase() };
    }
  }
}
