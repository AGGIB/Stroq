// Hooks that an artifact declares: commands the host runs on its own events.
//
// A skill declares them in its front matter and a plugin in `hooks/hooks.json` or its manifest; the
// shape is the same: an event, a list of groups, and in each group a list of hooks, each of which has a
// type and, for a command, the command. A hook is always a sensitive line, because it is code the host
// runs without being asked. Its command is also put to the shell reader. A shape that is not that one is
// a line that says so, on the basis `unknown`, and is not guessed at.
import type { Findings } from './findings.js';
import { entriesOf, isObject, own, ownString } from './json.js';
import type { ShellQueue } from './shell-queue.js';

/** The most hooks one declaration is read for. */
export const MAX_HOOKS = 100;

/** Where a declaration was found, for the words of the detector. */
export type HookSource = 'front matter' | 'a manifest';

const DETECTORS: Readonly<Record<HookSource, string>> = {
  'front matter':
    'hooks in front matter: a command the host runs on an event while the skill is active, as the skill declares it',
  'a manifest':
    'hooks in a manifest: a command the host runs on an event while the plugin is active, as the plugin declares it',
};

/** The variables a host fills in, which are places and not commands made at run time. */
const HOST_VARIABLES = /\$\{?(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}?/g;

/** A command with the variables of the host replaced by the names of the places they stand for. */
export const withHostVariables = (command: string): string =>
  command.replace(HOST_VARIABLES, (_, name: string) =>
    name === 'CLAUDE_PLUGIN_ROOT' ? 'PLUGIN_ROOT' : 'PROJECT_DIR',
  );

interface HookFound {
  readonly event: string;
  readonly command: string | null;
  readonly type: string;
}

/** The hooks a `hooks` value declares, or null when it is not shaped like hooks. */
export function hooksOf(value: unknown): HookFound[] | null {
  if (!isObject(value)) return null;
  const found: HookFound[] = [];
  for (const [event, groups] of entriesOf(value)) {
    if (!Array.isArray(groups)) return null;
    for (const group of groups as unknown[]) {
      if (!isObject(group)) return null;
      const inner: unknown = own(group, 'hooks');
      const hooks: unknown[] = Array.isArray(inner) ? (inner as unknown[]) : [group];
      for (const hook of hooks) {
        if (!isObject(hook)) return null;
        found.push({
          event,
          command: ownString(hook, 'command'),
          type: ownString(hook, 'type') ?? 'command',
        });
        if (found.length > MAX_HOOKS) return found;
      }
    }
  }
  return found;
}

/** Adds the lines of a `hooks` value found in `file` at `line`, and queues the commands for the shell reader. */
export function addHookLines(
  file: string,
  value: unknown,
  line: number,
  source: HookSource,
  findings: Findings,
  shell: ShellQueue,
): void {
  const detector = DETECTORS[source];
  const hooks = isObject(value) && Object.keys(value).length === 0 ? [] : hooksOf(value);
  if (hooks === null) {
    findings.line({
      kind: 'hook',
      subject: 'hooks declared (shape not understood)',
      basis: 'unknown',
      sensitive: true,
      file,
      line,
      detector,
    });
    return;
  }
  if (hooks.length > MAX_HOOKS) findings.tally('list-cut');
  for (const hook of hooks.slice(0, MAX_HOOKS)) {
    findings.line({
      kind: 'hook',
      subject: `${hook.event}: ${hook.command ?? `${hook.type} hook`}`,
      basis: 'declared',
      sensitive: true,
      file,
      line,
      detector,
    });
    if (hook.command !== null) {
      shell.add({ file, line, text: withHostVariables(hook.command), origin: 'hook' });
    }
  }
}
