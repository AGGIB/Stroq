import { posix } from 'node:path';
import type { TaggedHit } from './agent-change.js';
import { hit, type AgentKind } from './agent-kinds.js';

/**
 * A hook that was already there can start a file of the repository, and a change can edit that
 * file without touching the hook. The hook's value stays the same, so the comparison of values
 * calls it present, while what it runs is new. This finds the repository files that the command
 * line of an entry already there names, and reports each one the change touched.
 */

/** The kinds whose value is a command line, and what to call one in a sentence. */
const RUNS: Readonly<Partial<Record<AgentKind, string>>> = {
  'agent-hook': 'hook',
  'agent-helper-command': 'command',
  'agent-env': 'variable',
  'mcp-server': 'MCP server',
  'mcp-server-runs-code': 'MCP server',
  'editor-autorun-task': 'task',
  'agent-definition-hook': 'hook',
  'devcontainer-host-command': 'command',
  'devcontainer-command': 'command',
  'package-script': 'script',
  'package-script-agent-path': 'script',
};

/** The most words of one command line that are looked at. */
const MAX_WORDS = 256;
/** A leading project folder, as hooks and tasks write it: `$CLAUDE_PROJECT_DIR/x`, `${workspaceFolder}/x`. */
const PROJECT_DIR =
  /^\$\{?(?:CLAUDE_PROJECT_DIR|GEMINI_PROJECT_DIR|CURSOR_PROJECT_DIR|workspaceFolder|PWD)\}?\//;

/** The words of a command line that could be a path of the repository, normalised. */
export function pathWords(command: string): string[] {
  const words = command
    .replace(/["']/g, '')
    .split(/[\s;&|()<>`=,]+/)
    .slice(0, MAX_WORDS);
  return words.flatMap((word) => {
    const bare = word.replace(PROJECT_DIR, '');
    if (bare === '' || bare.startsWith('/') || bare.startsWith('-') || bare.includes('://'))
      return [];
    const path = posix.normalize(bare);
    return path === '.' || path === '..' || path.startsWith('../') ? [] : [path];
  });
}

/** How a path of the repository changed, by the path a host opens it at: A, M, T, or nothing. */
export type Touched = (path: string) => 'new' | 'changed' | undefined;

/**
 * One entry per repository file that a present entry runs and the change touched, as severe as
 * the entry that runs it.
 */
export function runFileChanges(hits: readonly TaggedHit[], touched: Touched): TaggedHit[] {
  const out = new Map<string, TaggedHit>();
  for (const h of hits) {
    const noun = RUNS[h.kind];
    if (noun === undefined || h.status !== 'present') continue;
    for (const path of pathWords(h.value)) {
      const status = touched(path);
      if (status === undefined) continue;
      const name = `${h.name} ${noun} in ${h.file}`;
      const key = `${path}\0${name}`;
      // As much as the entry that runs it: a hook's script fails, an ordinary server's code is
      // listed to review, as the server is.
      const severity = h.severity === 'error' ? 'error' : 'warning';
      if (!out.has(key))
        out.set(key, { ...hit('agent-run-file-changed', path, 1, name, path), severity, status });
    }
  }
  return [...out.values()];
}
