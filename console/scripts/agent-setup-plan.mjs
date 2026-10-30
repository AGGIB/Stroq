import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { MAX_CONFIG, snapshotFile } from './agent-setup-files.mjs';

export const AGENTS = ['claude-code', 'cursor', 'codex'];
const EVENTS = {
  'claude-code': ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
  cursor: [
    'preToolUse',
    'beforeShellExecution',
    'afterShellExecution',
    'beforeMCPExecution',
    'afterMCPExecution',
    'beforeReadFile',
    'afterFileEdit',
  ],
  codex: ['PreToolUse', 'PostToolUse'],
};
export const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'Stop',
  'Interrupt',
];
const BLOCKING = new Set([
  'PreToolUse',
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
]);
const DIRECT = new Set(['cursor']);
export const plain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const closed = (value, keys) =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function parseObject(bytes) {
  if (bytes === null) return {};
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = text.trim() ? JSON.parse(text) : {};
    if (!plain(value)) throw new Error();
    return value;
  } catch {
    throw new Error('invalid-config');
  }
}

/** Refuse shapes Connect cannot preserve and inspect without guessing. */
function validateConfig(value, agent) {
  if (value.hooks !== undefined && !plain(value.hooks)) throw new Error('invalid-config');
  if (agent === 'cursor' && value.version !== undefined && value.version !== 1)
    throw new Error('invalid-config');
  for (const key of ['disableAllHooks', 'hooksDisabled']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      throw new Error('invalid-config');
    if (value[key] === true) throw new Error('hooks-disabled');
  }
  const maps = [value.hooks ?? {}];
  if (agent === 'codex')
    maps.push(
      Object.fromEntries(
        CODEX_EVENTS.filter((key) => Object.hasOwn(value, key)).map((key) => [
          key,
          Array.isArray(value[key]) ? value[key] : [value[key]],
        ]),
      ),
    );
  for (const map of maps)
    for (const entries of Object.values(map)) {
      if (!Array.isArray(entries)) throw new Error('invalid-config');
      for (const entry of entries) {
        if (!plain(entry)) throw new Error('invalid-config');
        if (DIRECT.has(agent) && typeof entry.command !== 'string')
          throw new Error('invalid-config');
        if (
          !DIRECT.has(agent) &&
          (!Array.isArray(entry.hooks) || entry.hooks.some((hook) => !plain(hook)))
        )
          throw new Error('invalid-config');
      }
    }
}

const groupMetadata = (group) =>
  Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'hooks'));

function templatesFor(expected, agent, command) {
  if (!plain(expected) || !plain(expected.hooks)) throw new Error('invalid-engine-preview');
  validateConfig(expected, agent);
  if (!isDeepStrictEqual(Object.keys(expected.hooks), EVENTS[agent]))
    throw new Error('invalid-engine-preview');
  const templates = [];
  for (const [event, entries] of Object.entries(expected.hooks)) {
    for (const entry of entries) {
      const group = DIRECT.has(agent) ? null : groupMetadata(entry);
      for (const handler of DIRECT.has(agent) ? [entry] : entry.hooks) {
        if (handler.command !== command) throw new Error('invalid-engine-preview');
        templates.push({ event, group, handler });
      }
    }
  }
  if (templates.length !== EVENTS[agent].length) throw new Error('invalid-engine-preview');
  return templates;
}

function exactTemplate(templates, event, handler, group) {
  return templates.findIndex(
    (template) =>
      template.event === event &&
      isDeepStrictEqual(template.handler, handler) &&
      isDeepStrictEqual(template.group, group),
  );
}

function visitHandlers(config, agent, action) {
  function eventEntries(event, entries) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (DIRECT.has(agent)) action(event, entry, null);
      else for (const handler of entry.hooks) action(event, handler, groupMetadata(entry));
    }
  }
  for (const [event, entries] of Object.entries(config.hooks ?? {})) eventEntries(event, entries);
  if (agent === 'codex')
    for (const event of CODEX_EVENTS)
      if (Object.hasOwn(config, event)) eventEntries(event, config[event]);
}

/** Only exact templates may disappear. Foreign handlers, group metadata and root shapes survive. */
function foreignPart(value, original, agent, templates) {
  const result = structuredClone(value);
  function strip(event, entries, initial) {
    const single = !Array.isArray(entries);
    let removed = false;
    const retained = (single ? [entries] : entries).flatMap((entry) => {
      if (DIRECT.has(agent)) {
        if (exactTemplate(templates, event, entry, null) < 0) return [entry];
        removed = true;
        return [];
      }
      const hooks = entry.hooks.filter((handler) => {
        if (exactTemplate(templates, event, handler, groupMetadata(entry)) < 0) return true;
        removed = true;
        return false;
      });
      if (hooks.length === entry.hooks.length) return [entry];
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    // An originally empty array is user content, even when Connect appends its first template.
    if (removed && retained.length === 0 && !(Array.isArray(initial) && initial.length === 0))
      return { removed, value: undefined };
    return { removed, value: single ? retained[0] : retained };
  }
  if (plain(result.hooks)) {
    let removed = false;
    for (const [event, entries] of Object.entries(result.hooks)) {
      const projected = strip(event, entries, original.hooks?.[event]);
      removed ||= projected.removed;
      if (projected.value === undefined) delete result.hooks[event];
      else result.hooks[event] = projected.value;
    }
    if (
      removed &&
      Object.keys(result.hooks).length === 0 &&
      !(plain(original.hooks) && Object.keys(original.hooks).length === 0)
    )
      delete result.hooks;
  }
  if (agent === 'codex')
    for (const event of CODEX_EVENTS) {
      if (!Object.hasOwn(result, event)) continue;
      const projected = strip(event, result[event], original[event]);
      if (projected.value === undefined) delete result[event];
      else result[event] = projected.value;
    }
  // The sole non-hook template field is Cursor's required schema version.
  if (agent === 'cursor' && original.version === undefined && result.version === 1)
    delete result.version;
  return result;
}

export function targetFor(agent, scope) {
  if (agent === 'claude-code') return '.claude/settings.json';
  return `.${agent}/hooks.json`;
}

export async function readSetupInputs(agent, scope, roots, parser = parseObject) {
  const root = scope === 'project' ? roots.projectRoot : roots.userRoot;
  const file = join(root.path, targetFor(agent, scope));
  const before = await snapshotFile(root, file);
  const config = parser(before.bytes);
  validateConfig(config, agent);
  const recordFile = join(roots.userRoot.path, '.stroq', 'install.json');
  const recordBefore = await snapshotFile(roots.userRoot, recordFile);
  let record;
  try {
    record = parser(recordBefore.bytes);
  } catch {
    throw new Error('invalid-install-record');
  }
  if (
    recordBefore.bytes !== null &&
    (record.version !== 1 ||
      !plain(record.entries) ||
      Object.values(record.entries).some(
        (entry) =>
          !plain(entry) ||
          typeof entry.command !== 'string' ||
          typeof entry.recordedAt !== 'string',
      ))
  )
    throw new Error('invalid-install-record');
  return { config, root, file, before, recordFile, recordBefore, record };
}

export function completePlan(input, prepared, agent, scope, options, id, now) {
  if (
    !closed(prepared, [
      'candidateText',
      'hookEvents',
      'preservedHooks',
      'replacedHooks',
      'addedHooks',
      'remainingLookalikes',
    ]) ||
    typeof prepared.candidateText !== 'string' ||
    typeof options.parseSetupObject !== 'function'
  )
    throw new Error('invalid-engine-preview');
  const merged = Buffer.from(prepared.candidateText, 'utf8');
  if (merged.length > MAX_CONFIG) throw new Error('config-too-large');
  const next = options.parseSetupObject(merged);
  validateConfig(next, agent);
  if (
    input.before.bytes !== null &&
    isDeepStrictEqual(input.config, next) &&
    !merged.equals(input.before.bytes)
  )
    throw new Error('invalid-engine-preview');
  const command = `"${process.execPath}" "${options.paths.cli}" hook ${agent}`;
  const templates = templatesFor(options.expected, agent, command);
  if (
    !isDeepStrictEqual(
      foreignPart(input.config, input.config, agent, templates),
      foreignPart(next, input.config, agent, templates),
    )
  )
    throw new Error('merge-not-preserving');
  const counts = templates.map(() => 0),
    nextCounts = templates.map(() => 0);
  let preservedHooks = 0,
    remainingLookalikes = 0;
  const lookalike = new RegExp(`(?:^|\\s)hook\\s+${agent}(?:\\s|$)`);
  visitHandlers(input.config, agent, (event, handler, group) => {
    const index = exactTemplate(templates, event, handler, group);
    if (index >= 0) counts[index] += 1;
    else {
      preservedHooks += 1;
      if (typeof handler.command === 'string' && lookalike.test(handler.command))
        remainingLookalikes += 1;
    }
  });
  visitHandlers(next, agent, (event, handler, group) => {
    const index = exactTemplate(templates, event, handler, group);
    if (index >= 0) nextCounts[index] += 1;
  });
  if (nextCounts.some((count) => count !== 1)) throw new Error('invalid-engine-preview');
  const addedHooks = counts.filter((count) => count === 0).length;
  const replacedHooks = counts.reduce((total, count) => total + Math.max(0, count - 1), 0);
  const hookEvents = templates.map(({ event, handler, group }) => ({
    event,
    matcher: group?.matcher ?? handler.matcher ?? null,
    blocking: BLOCKING.has(event),
    failClosed: agent === 'cursor' ? handler.failClosed === true : null,
    timeoutSeconds: typeof handler.timeout === 'number' ? handler.timeout : null,
  }));
  if (
    !isDeepStrictEqual(prepared.hookEvents, hookEvents) ||
    Object.entries({ preservedHooks, replacedHooks, addedHooks, remainingLookalikes }).some(
      ([key, value]) =>
        !Number.isSafeInteger(value) || value < 0 || value > 4096 || prepared[key] !== value,
    )
  )
    throw new Error('invalid-engine-preview');
  const entry = input.record.entries?.[`${agent}:${scope}`];
  const configUnchanged = input.before.bytes !== null && merged.equals(input.before.bytes);
  const recordNext =
    configUnchanged || entry?.command === command
      ? input.recordBefore.bytes
      : Buffer.from(
          `${JSON.stringify({ ...input.record, version: 1, entries: { ...input.record.entries, [`${agent}:${scope}`]: { command, recordedAt: new Date(now).toISOString() } } }, null, 2)}\n`,
        );
  if (recordNext !== null && recordNext.length > MAX_CONFIG) throw new Error('config-too-large');
  return {
    id,
    agent,
    scope,
    config: { root: input.root, file: input.file, before: input.before, next: merged },
    record: {
      root: options.userRoot,
      file: input.recordFile,
      before: input.recordBefore,
      next: recordNext,
    },
    userRoot: options.userRoot,
    hookEvents,
    preservedHooks,
    replacedHooks,
    addedHooks,
    remainingLookalikes,
  };
}

export function nextSteps(agent, scope) {
  return [
    ...(agent === 'codex'
      ? [
          'Approve the new or changed hooks inside Codex. Until approval, they do not run.',
          ...(scope === 'project'
            ? ['Trust this workspace in Codex so its project configuration can load.']
            : []),
          'Older Codex versions may require hooks = true in the [features] section of config.toml.',
        ]
      : []),
    agent === 'cursor'
      ? 'Restart the agent application to load its hooks.'
      : 'Start a new agent session to load its hooks.',
    'Run installation checks, then inspect observed hook activity. This installation does not prove that a live agent blocks an action.',
    'Keep this Stroq installation folder and its Node runtime available; the hooks refer to this local build.',
  ];
}
