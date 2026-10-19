import { createHash } from 'node:crypto';

/**
 * What a repository can carry that an AI agent or an editor runs by itself once the folder
 * is open: the kinds `stroq inspect` reports, each with one severity.
 *
 * `error` is something that runs a command, sends the agent's traffic elsewhere or switches a
 * prompt off. `warning` runs something too, but is ordinary in many honest repositories (an
 * MCP server started from a package, a dev container's build step). `notice` runs nothing: an
 * instruction file the agent reads in every session, worth a look only when it changes.
 */
export const KIND_SEVERITY = {
  'agent-hook': 'error',
  'agent-helper-command': 'error',
  'agent-api-redirect': 'error',
  'agent-permission-bypass': 'error',
  'agent-plugin': 'error',
  'mcp-auto-approve': 'error',
  'mcp-server-runs-code': 'error',
  'mcp-server': 'warning',
  'editor-autorun-task': 'error',
  'agent-definition-hook': 'error',
  'instruction-hidden-text': 'error',
  'instruction-file': 'notice',
  'devcontainer-host-command': 'error',
  'devcontainer-command': 'warning',
  'package-script-agent-path': 'error',
  'package-script': 'warning',
  'nested-bare-repo': 'error',
  'unreadable-config': 'error',
  'config-link-outside': 'warning',
} as const;

export type AgentKind = keyof typeof KIND_SEVERITY;
export type Severity = 'error' | 'warning' | 'notice';

export const AGENT_KINDS = Object.keys(KIND_SEVERITY) as readonly AgentKind[];

export interface AgentHit {
  readonly kind: AgentKind;
  /** Repository-relative, with `/` between the parts. */
  readonly file: string;
  /** From 1. The best line the reader could find; 1 when it found none. */
  readonly line: number;
  /** Which entry of the file this is: the hook's event, the server's name, the task's label. */
  readonly name: string;
  /** What runs, or what decides what runs. Two revisions are compared by this. */
  readonly value: string;
  readonly severity: Severity;
}

export const hit = (
  kind: AgentKind,
  file: string,
  line: number,
  name: string,
  value: string,
): AgentHit => ({ kind, file, line, name, value, severity: KIND_SEVERITY[kind] });

/**
 * A short digest of a text, for a hit whose value is a whole file: an instruction file, or a
 * config that could not be read. Any change to the file changes it, which is all it is for.
 */
export const digestOf = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

/** The hits of one file in the order of their lines, the reader's order kept within a line. */
export const byLine = (hits: readonly AgentHit[]): AgentHit[] =>
  hits
    .map((h, i) => [h, i] as const)
    .sort(([a, i], [b, j]) => a.line - b.line || i - j)
    .map(([h]) => h);
