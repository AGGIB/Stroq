// What the front matter of a skill declares, as lines of the passport.
//
// `allowed-tools` becomes a line per tool and `hooks` a line per hook, all of them `declared`: the
// artifact says so about itself. The text of a hook is also put to the shell reader, which says what
// the command would do. A front matter that cannot be read is a signal.
import type { Findings } from './findings.js';
import { readFrontmatter } from './frontmatter.js';
import type { Identity } from './identity.js';
import type { InspectInput } from './input.js';
import { entriesOf, isObject, own, ownObject, ownString, type JsonObject } from './json.js';
import type { ShellQueue } from './shell-queue.js';
import type { TextFile } from './text-files.js';
import { splitToolList, toolIsSensitive } from './tool-spec.js';

const TOOLS_DETECTOR =
  'allowed-tools in front matter: what the skill asks to be allowed to use without asking, as the skill declares it';
const HOOK_DETECTOR =
  'hooks in front matter: a command the host runs on an event while the skill is active, as the skill declares it';
const UNREADABLE_DETECTOR =
  'the front matter could not be read, so what it declares (allowed-tools, hooks) is not known; a signal to look at, not a verdict';

/** The most hooks one front matter is read for. */
const MAX_HOOKS = 100;

/** Whether a file has front matter that declares things: a SKILL.md anywhere, or a command of a plugin. */
export function hasDeclaringFrontmatter(path: string): boolean {
  return (
    path === 'SKILL.md' || path.endsWith('/SKILL.md') || /(?:^|\/)commands\/[^/]+\.md$/.test(path)
  );
}

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

function toolLines(file: TextFile, value: unknown, line: number, findings: Findings): boolean {
  const lists = Array.isArray(value) ? (value as unknown[]) : [value];
  if (lists.length === 0 || !lists.every((item) => typeof item === 'string')) return false;
  for (const item of lists as string[]) {
    const { tools, cut } = splitToolList(item);
    if (cut) findings.tally('list-cut');
    for (const tool of tools) {
      findings.line({
        kind: 'allowed-tools',
        subject: tool,
        basis: 'declared',
        sensitive: toolIsSensitive(tool),
        file: file.path,
        line,
        detector: TOOLS_DETECTOR,
      });
    }
  }
  return true;
}

function hookLines(
  file: TextFile,
  value: unknown,
  line: number,
  findings: Findings,
  shell: ShellQueue,
): void {
  const hooks = isObject(value) && Object.keys(value).length === 0 ? [] : hooksOf(value);
  if (hooks === null) {
    findings.line({
      kind: 'hook',
      subject: 'hooks declared (shape not understood)',
      basis: 'unknown',
      sensitive: true,
      file: file.path,
      line,
      detector: HOOK_DETECTOR,
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
      file: file.path,
      line,
      detector: HOOK_DETECTOR,
    });
    if (hook.command !== null) {
      shell.add({ file: file.path, line, text: hook.command, origin: 'hook' });
    }
  }
}

function unreadable(file: TextFile, reason: string, tooLong: boolean, findings: Findings): void {
  if (tooLong) findings.tally('frontmatter-too-long');
  findings.signal({
    ruleId: 'frontmatter-unreadable',
    file: file.path,
    line: 1,
    sensitive: true,
    detail: `the front matter ${reason}`,
    detector: UNREADABLE_DETECTOR,
  });
}

/** The version a skill declares: `version`, or `version` under `metadata`; text or a number. */
function versionOf(data: JsonObject): string | null {
  const asText = (value: unknown): string | null =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  const metadata = ownObject(data, 'metadata');
  return (
    asText(own(data, 'version')) ?? (metadata === null ? null : asText(own(metadata, 'version')))
  );
}

/**
 * Reads the front matter of every file that declares things, adds its lines, and says what the skill
 * at the root calls itself.
 */
export function inspectFrontmatter(
  input: InspectInput,
  findings: Findings,
  shell: ShellQueue,
): Partial<Identity> {
  let identity: Partial<Identity> = {};
  for (const file of input.texts) {
    if (!hasDeclaringFrontmatter(file.path)) continue;
    const front = readFrontmatter(file);
    if (front.status === 'absent') continue;
    if (front.status === 'broken') {
      unreadable(file, front.reason, front.tooLong, findings);
      continue;
    }
    const { data, keyLines } = front;
    const tools = own(data, 'allowed-tools');
    if (tools !== undefined && tools !== null) {
      const line = keyLines.get('allowed-tools') ?? 1;
      if (!toolLines(file, tools, line, findings)) {
        unreadable(
          file,
          'declares allowed-tools that is neither text nor a list of text',
          false,
          findings,
        );
      }
    }
    const hooks = own(data, 'hooks');
    if (hooks !== undefined && hooks !== null) {
      hookLines(file, hooks, keyLines.get('hooks') ?? 1, findings, shell);
    }
    if (file.path === 'SKILL.md') {
      const name = ownString(data, 'name');
      const version = versionOf(data);
      identity = {
        ...(name === null ? {} : { name }),
        ...(version === null ? {} : { version }),
      };
    }
  }
  return identity;
}
