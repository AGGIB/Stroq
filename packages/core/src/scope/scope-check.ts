import { parseMcpToolName } from '../actions/classify-tool.js';
import { isShellTool } from '../actions/shell-tools.js';
import type { ActionClass, ToolResources } from '../types.js';
import { neutralizeControls } from '../util/controls.js';
import { fileTarget, fingerprintOf, genericTarget, mcpTarget, shellTarget } from './fingerprint.js';
import { type PathOptions, evaluatePath } from './paths.js';
import type { ScopeGateInput, TaskScope } from './types.js';

/**
 * What a task's scope refuses (step 3 of the gate), and the name of each operation refused,
 * for `stroq permit extend` to take. Pure: no files, no clock, no keys.
 */

/** One refusal, with the fingerprints an escalation would have to name to lift it. */
export interface Refusal {
  readonly ruleId: string;
  readonly reason: string;
  readonly fingerprints: readonly string[];
}

/** The tools that name files, and so that the scope's path rules are held against. */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

// The classifier reports a search root, not an inventory of every descendant the tool
// may open. Until the launcher supplies that stronger contract, these calls need an
// exact-call extension, including pattern/options, even when their root resolved.
const RECURSIVE_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'LS']);

const fileFingerprints = (tool: string): boolean => tool === 'Read';

/** Tools that name no file, and so need no resources to be held to a path scope. */
const PATHLESS_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'TodoRead',
  'ExitPlanMode',
  'WebSearch',
]);

const NETWORK_CLASSES: readonly ActionClass[] = [
  'shell.network',
  'network.fetch',
  'git.push_external',
];

const MAX_SHOWN_CHARS = 160;
const MAX_HOST_CHARS = 253;

/** Text from the agent, on one line and without anything a terminal would obey. */
const show = (text: string): string =>
  neutralizeControls(text)
    .replace(/[\n\t]/g, ' ')
    .slice(0, MAX_SHOWN_CHARS);

type PathEntry = ToolResources['paths'][number];

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function mcpOf(input: ScopeGateInput): { server: string; tool: string } | null {
  return input.classification.mcp ?? parseMcpToolName(input.event.toolName);
}

/** Read-only extensions retain a target fingerprint; mutations bind the whole call below. */
const pathFingerprint = (tool: string, entry: PathEntry): string =>
  fingerprintOf(tool, `file:${entry.op}`, fileTarget(entry.path, entry.real));

/** Bind exact-call approval to execution context as well as every argument. */
export const wholeCallFingerprint = (input: ScopeGateInput): string => {
  const { toolName, toolInput } = input.event;
  const boundTarget = (target: string): string =>
    genericTarget({
      target,
      cwd: input.event.cwd,
      toolInput,
      // A changed symlink target is a different operation even when the written path and
      // cwd are identical. Missing resources remain explicit rather than a wildcard.
      resources: input.classification.resources ?? null,
    });
  if (isShellTool(toolName)) {
    const command = toolInput['command'];
    return fingerprintOf(
      toolName,
      'shell',
      boundTarget(typeof command === 'string' ? shellTarget(command) : genericTarget(toolInput)),
    );
  }
  if (toolName.startsWith('mcp__')) {
    const mcp = mcpOf(input);
    return fingerprintOf(
      toolName,
      'mcp',
      boundTarget(
        mcp === null ? genericTarget(toolInput) : mcpTarget(mcp.server, mcp.tool, toolInput),
      ),
    );
  }
  return fingerprintOf(toolName, 'tool', boundTarget(genericTarget(toolInput)));
};

/** A host as it should be compared: lower case, no port, no trailing dot, plain DNS characters. */
function hostName(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_HOST_CHARS + 8) return null;
  const host = raw.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (host.length === 0 || host.length > MAX_HOST_CHARS || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host.split('.').every((label) => label.length > 0) ? host : null;
}

function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );
}

/**
 * Options of a program that make a connection go somewhere other than the address it is given:
 * curl's `--connect-to`, `--resolve`, `--proxy`, `--preproxy` and `--socks*`. Under a scope that
 * lists hosts the address would be checked and the connection made elsewhere.
 */
const REDIRECTING_OPTION =
  /(?:^|\s)(?:--(?:connect-to|resolve|preproxy|socks[45][a-z-]*|proxy[a-z0-9.-]*)(?:[=\s]|$)|-x\s)/;

function networkRefusal(scope: TaskScope, input: ScopeGateInput, whole: string): Refusal | null {
  const classes = input.classes.filter((name) => NETWORK_CLASSES.includes(name));
  const urls = input.classification.resources?.urls ?? [];
  const named = [...urls.map((u) => u.host), ...input.classification.hosts];
  // An address in a command is a network operation whatever class the command got: `git fetch URL`,
  // `git clone`, `npm install URL` carry no network class, and an address in a query string can
  // carry what a file holds. A command that only prints an address is refused too; an exact-call
  // extension lifts that.
  if (classes.length === 0 && named.length === 0) return null;
  const what = classes.length > 0 ? classes.join(', ') : 'an address in the call';
  if (scope.net.mode === 'none') {
    return {
      ruleId: 'task-scope-net',
      reason: `network access (${what}) is not part of this task`,
      fingerprints: [whole],
    };
  }
  const command = input.event.toolInput['command'];
  if (typeof command === 'string' && REDIRECTING_OPTION.test(command)) {
    return {
      ruleId: 'task-scope-net',
      reason:
        'an option that sends the connection somewhere other than the address is not part of this task',
      fingerprints: [whole],
    };
  }
  const refused = named.find((raw) => {
    const host = hostName(raw);
    return host === null || !hostAllowed(host, scope.net.mode === 'hosts' ? scope.net.hosts : []);
  });
  if (named.length > 0 && refused === undefined) return null;
  return {
    ruleId: 'task-scope-net',
    reason:
      refused === undefined
        ? `network access (${what}) to a host that could not be read is not part of this task`
        : `host ${show(refused)} is not in this task's network scope`,
    fingerprints: [whole],
  };
}

function pathRefusal(
  scope: TaskScope,
  input: ScopeGateInput,
  opts: PathOptions,
  whole: string,
): Refusal | null {
  const tool = input.event.toolName;
  const refused = (input.classification.resources?.paths ?? [])
    .map((entry) => ({
      entry,
      verdict: evaluatePath(entry.op === 'read' ? scope.read : scope.write, entry, opts),
    }))
    .filter(({ verdict }) => verdict !== 'allow');
  const first = refused[0];
  if (first === undefined) return null;
  const { entry, verdict } = first;
  const real =
    entry.real !== undefined && entry.real !== entry.path ? ` (really ${show(entry.real)})` : '';
  return {
    ruleId: 'task-scope-path',
    reason: `${entry.op} of ${show(entry.path)}${real} is ${verdict === 'deny' ? 'excluded from' : 'outside'} this task's ${entry.op} scope`,
    fingerprints: fileFingerprints(tool)
      ? unique(refused.map((r) => pathFingerprint(tool, r.entry)))
      : [whole],
  };
}

/**
 * Every way this call falls outside the scope, in the order: tool, shell, path, incomplete,
 * network. Empty when it is inside.
 *
 * An allowed shell command is not held to the path rules: the hook sees the text of a
 * command and not what the programs it starts will open (`python x.py`, `npm test`). File
 * access by those is enforced by the operating system's sandbox when there is one; the paths
 * the classifier happens to find in a command are no basis for a promise.
 */
export function checkScope(scope: TaskScope, input: ScopeGateInput, opts: PathOptions): Refusal[] {
  const { toolName } = input.event;
  const whole = wholeCallFingerprint(input);
  const refusals: Array<Refusal | null> = [];

  if (toolName.startsWith('mcp__')) {
    const mcp = mcpOf(input);
    // `mcp__a__b__c` is server `a` with tool `b__c`, or server `a__b` with tool `c`: the name does
    // not say which. A server whose own name holds `__` is never granted by a name that does.
    const listed =
      mcp !== null &&
      !mcp.tool.includes('__') &&
      scope.mcp.some(
        (grant) =>
          grant.server === mcp.server && (grant.tools === '*' || grant.tools.includes(mcp.tool)),
      );
    refusals.push(
      listed
        ? null
        : {
            ruleId: 'task-scope-mcp',
            reason: `MCP tool ${show(toolName)} is not in this task's scope`,
            fingerprints: [whole],
          },
    );
  } else if (!scope.tools.includes(toolName)) {
    refusals.push({
      ruleId: 'task-scope-tool',
      reason: `tool ${show(toolName)} is not in this task's scope`,
      fingerprints: [whole],
    });
  }

  const shell = isShellTool(toolName);
  if (shell && scope.shell === 'denied') {
    refusals.push({
      ruleId: 'task-scope-shell',
      reason: "this task's scope does not allow shell commands",
      fingerprints: [whole],
    });
  }

  if (!shell) refusals.push(pathRefusal(scope, input, opts, whole));

  const resources = input.classification.resources;
  const pathsComplete = resources?.pathsComplete;
  // A tool the classifier gave no resources at all (`NotebookRead`, `LSP`, anything new) may open
  // any file, and nothing here knows which: it is held to the scope as an incomplete call is,
  // unless it is one that names no file by its nature.
  const unread =
    resources === undefined && !toolName.startsWith('mcp__') && !PATHLESS_TOOLS.has(toolName);
  if (
    !shell &&
    (pathsComplete === false ||
      unread ||
      (FILE_TOOLS.has(toolName) && pathsComplete !== true) ||
      RECURSIVE_TOOLS.has(toolName))
  ) {
    refusals.push({
      ruleId: 'task-scope-incomplete',
      reason: `the paths ${show(toolName)} will touch could not be read in full, so they cannot be held to this task's scope`,
      fingerprints: [whole],
    });
  }

  refusals.push(networkRefusal(scope, input, whole));
  return refusals.filter((refusal): refusal is Refusal => refusal !== null);
}
