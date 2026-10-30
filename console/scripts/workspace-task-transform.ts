import { Buffer } from 'node:buffer';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json.js';
import { stripJsonc } from '../../packages/cli/src/exposure/jsonc.js';

export const WORKSPACE_TASK_MAX_BYTES = 256 * 1024;
export const WORKSPACE_TASK_MAX_TASKS = 256;
type Trigger = 'folderOpen' | 'worktreeCreated';
type ObjectValue = Record<string, unknown>;
interface Replacement {
  start: number;
  end: number;
  trigger: Trigger;
}
export interface WorkspaceTaskPlan {
  bytes: Buffer;
  changes: Record<Trigger, number>;
}
function fail(): never {
  throw new Error('unsupported-task-config');
}
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const OS_KEYS = ['windows', 'osx', 'linux'] as const;

function trigger(value: unknown): Trigger | null {
  if (typeof value !== 'string') return fail();
  switch (value.toLowerCase()) {
    case 'folderopen':
      return 'folderOpen';
    case 'worktreecreated':
      return 'worktreeCreated';
    case 'default':
      return null;
    default:
      return fail();
  }
}

/** These placements are not supported task-level run options in the v2 schema. */
function validateOs(value: ObjectValue, root: boolean): void {
  for (const key of OS_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const variant = value[key];
    if (
      !object(variant) ||
      Object.hasOwn(variant, 'runOptions') ||
      (root && Object.hasOwn(variant, 'tasks'))
    )
      fail();
  }
}

function targets(value: unknown): Map<number, Trigger> {
  if (
    !object(value) ||
    value.version !== '2.0.0' ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > WORKSPACE_TASK_MAX_TASKS ||
    Object.hasOwn(value, 'runOptions')
  )
    fail();
  validateOs(value, true);
  const found = new Map<number, Trigger>();
  for (const [index, task] of value.tasks.entries()) {
    if (!object(task)) fail();
    validateOs(task, false);
    if (!Object.hasOwn(task, 'runOptions')) continue;
    const options = task.runOptions;
    if (!object(options)) fail();
    if (!Object.hasOwn(options, 'runOn')) continue;
    const automatic = trigger(options.runOn);
    if (automatic !== null) found.set(index, automatic);
  }
  return found;
}

/**
 * Walk already-validated, comment-blanked JSON once. It retains offsets into the
 * original text, decodes property names, and never searches command/comment text.
 * The strict reader has already bounded nesting to 32 and refused duplicate keys.
 */
function replacements(text: string, selected: ReadonlyMap<number, Trigger>): Replacement[] {
  let at = 0;
  const found: Replacement[] = [];
  const space = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at++;
  };
  const string = () => {
    if (text[at] !== '"') return fail();
    const start = at++;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    if (at >= text.length) return fail();
    at++;
    return { start, end: at, value: JSON.parse(text.slice(start, at)) as string };
  };
  function visit(path: readonly (string | number)[]): void {
    space();
    if (text[at] === '{') {
      at++;
      space();
      while (text[at] !== '}') {
        const key = string().value;
        space();
        if (text[at++] !== ':') fail();
        visit([...path, key]);
        space();
        if (text[at] !== ',') break;
        at++;
        space();
      }
      if (text[at++] !== '}') fail();
      return;
    }
    if (text[at] === '[') {
      at++;
      space();
      let index = 0;
      while (text[at] !== ']') {
        visit([...path, index++]);
        space();
        if (text[at] !== ',') break;
        at++;
        space();
      }
      if (text[at++] !== ']') fail();
      return;
    }
    if (text[at] === '"') {
      const token = string();
      if (
        path.length === 4 &&
        path[0] === 'tasks' &&
        typeof path[1] === 'number' &&
        path[2] === 'runOptions' &&
        path[3] === 'runOn'
      ) {
        const automatic = selected.get(path[1]);
        if (automatic !== undefined) {
          if (trigger(token.value) !== automatic) fail();
          found.push({ start: token.start, end: token.end, trigger: automatic });
        }
      }
      return;
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) at++;
    if (start === at) fail();
  }
  visit([]);
  space();
  if (at !== text.length || found.length !== selected.size) fail();
  return found;
}

/** Pure plan only: preserve every original byte outside known task runOn string tokens. */
export function planWorkspaceTasks(bytes: Uint8Array): WorkspaceTaskPlan {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WORKSPACE_TASK_MAX_BYTES) fail();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail();
  }
  const stripped = stripJsonc(text);
  const parsed = parseStrictJson(stripped);
  if (!parsed.ok) fail();
  const selected = targets(parsed.value);
  if (!selected.size) throw new Error('no-automatic-tasks');
  const edits = replacements(stripped, selected);
  const changes = { folderOpen: 0, worktreeCreated: 0 };
  const parts: string[] = [];
  let from = 0;
  for (const edit of edits) {
    parts.push(text.slice(from, edit.start), '"default"');
    changes[edit.trigger]++;
    from = edit.end;
  }
  parts.push(text.slice(from));
  return { bytes: Buffer.from(parts.join(''), 'utf8'), changes };
}
