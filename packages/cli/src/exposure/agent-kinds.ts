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
  'agent-env': 'error',
  'agent-permission-bypass': 'error',
  'agent-broad-allow': 'warning',
  'agent-plugin': 'error',
  'mcp-auto-approve': 'error',
  'mcp-server-runs-code': 'error',
  'mcp-server': 'warning',
  'editor-autorun-task': 'error',
  'agent-definition-hook': 'error',
  'instruction-hidden-text': 'error',
  'instruction-file': 'notice',
  'binary-file': 'notice',
  'devcontainer-host-command': 'error',
  'devcontainer-command': 'warning',
  'package-script-agent-path': 'error',
  'package-script': 'warning',
  'nested-bare-repo': 'error',
  'unreadable-config': 'error',
  'config-link-outside': 'warning',
  'config-submodule': 'error',
  'agent-run-file-changed': 'error',
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

/** The most characters of a value written out by `boundedJson` before it is cut. */
const JSON_TEXT_MAX = 1024;

interface Frame {
  readonly close: string;
  readonly items: readonly (readonly [key: string | null, value: unknown])[];
  next: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A value from a repository as JSON text, for a hit's value. `JSON.stringify` recurses, so a
 * value nested 100,000 levels deep (which `JSON.parse` reads from under a megabyte) overflows
 * the stack. This walks with a stack of its own and keeps the first `max` characters; when it
 * cuts, a digest of the whole text follows, so two values that differ past the cut still differ.
 */
export function boundedJson(value: unknown, max = JSON_TEXT_MAX): string {
  const hash = createHash('sha256');
  let shown = '';
  const emit = (text: string): void => {
    hash.update(text);
    if (shown.length <= max) shown += text.slice(0, max + 1);
  };
  const stack: Frame[] = [];
  const open = (v: unknown): void => {
    if (Array.isArray(v)) {
      emit('[');
      stack.push({ close: ']', items: v.map((item) => [null, item] as const), next: 0 });
    } else if (isRecord(v)) {
      emit('{');
      stack.push({ close: '}', items: Object.entries(v), next: 0 });
    } else {
      emit(JSON.stringify(v) ?? 'null');
    }
  };
  open(value);
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    if (top.next >= top.items.length) {
      emit(top.close);
      stack.pop();
      continue;
    }
    const [key, item] = top.items[top.next] as readonly [string | null, unknown];
    emit(`${top.next > 0 ? ',' : ''}${key === null ? '' : `${JSON.stringify(key)}:`}`);
    top.next += 1;
    open(item);
  }
  if (shown.length <= max) return shown;
  return `${shown.slice(0, max)}... (sha256:${hash.digest('hex').slice(0, 16)})`;
}

/** The hits of one file in the order of their lines, the reader's order kept within a line. */
export const byLine = (hits: readonly AgentHit[]): AgentHit[] =>
  hits
    .map((h, i) => [h, i] as const)
    .sort(([a, i], [b, j]) => a.line - b.line || i - j)
    .map(([h]) => h);
