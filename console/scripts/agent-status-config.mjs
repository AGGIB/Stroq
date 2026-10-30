import { isDeepStrictEqual } from 'node:util';
import { CODEX_EVENTS, plain } from './agent-setup-plan.mjs';

const DIRECT = new Set(['cursor']);
const resemblesStroq = (entry, agent) =>
  typeof entry?.command === 'string' &&
  new RegExp(`(?:^|\\s)hook\\s+${agent}(?:\\s|$)`).test(entry.command);

/** Malformed entries cannot disappear into a tolerant merge and become a positive state. */
export function validConfiguration(value, agent) {
  if (!plain(value) || (value.hooks !== undefined && !plain(value.hooks))) return false;
  if (agent === 'cursor' && value.version !== undefined && value.version !== 1) return false;
  if (
    ['disableAllHooks', 'hooksDisabled'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    )
  )
    return false;
  const maps = [value.hooks ?? {}];
  if (agent === 'codex')
    maps.push(
      Object.fromEntries(
        CODEX_EVENTS.filter((event) => Object.hasOwn(value, event)).map((event) => [
          event,
          Array.isArray(value[event]) ? value[event] : [value[event]],
        ]),
      ),
    );
  for (const entries of maps.flatMap((map) => Object.values(map))) {
    if (!Array.isArray(entries)) return false;
    for (const entry of entries) {
      if (!plain(entry)) return false;
      if (DIRECT.has(agent)) {
        if (typeof entry.command !== 'string') return false;
      } else if (!Array.isArray(entry.hooks) || entry.hooks.some((hook) => !plain(hook)))
        return false;
    }
  }
  return true;
}

function handlers(config, event, agent) {
  const entries = [
    ...(config.hooks?.[event] ?? []),
    ...(agent === 'codex' && CODEX_EVENTS.includes(event) && Object.hasOwn(config, event)
      ? Array.isArray(config[event])
        ? config[event]
        : [config[event]]
      : []),
  ];
  return DIRECT.has(agent)
    ? entries
    : entries.flatMap((group) =>
        group.hooks.map((handler) => ({
          group: Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'hooks')),
          handler,
        })),
      );
}
const entryHandler = (entry, agent) => (DIRECT.has(agent) ? entry : entry.handler);

/** Exact templates establish configuration; resembling unmatched commands still require review. */
export function inspectConfiguration(config, expected, agent) {
  const events = Object.keys(expected.hooks).map((event) => {
    const wanted = handlers(expected, event, agent)[0];
    const entries = handlers(config, event, agent);
    const candidates = entries.filter((entry) => resemblesStroq(entryHandler(entry, agent), agent));
    if (candidates.length === 0) return { event, state: 'missing', reason: 'hooks-missing' };
    const command = entryHandler(wanted, agent).command;
    const exactCommand = candidates.every(
      (entry) => entryHandler(entry, agent).command === command,
    );
    if (!exactCommand) return { event, state: 'changed', reason: 'hook-command-changed' };
    const exact = candidates.length === 1 && isDeepStrictEqual(candidates[0], wanted);
    return {
      event,
      state: exact ? 'present' : 'changed',
      reason: exact ? 'matches-current-install' : 'hook-options-changed',
    };
  });
  const configuredEvents = [
    ...new Set([
      ...Object.keys(config.hooks ?? {}),
      ...(agent === 'codex' ? CODEX_EVENTS.filter((event) => Object.hasOwn(config, event)) : []),
    ]),
  ];
  const anyCandidate = configuredEvents.some((event) =>
    handlers(config, event, agent).some((entry) =>
      resemblesStroq(entryHandler(entry, agent), agent),
    ),
  );
  const unknownCandidate = configuredEvents.some(
    (event) =>
      !Object.hasOwn(expected.hooks, event) &&
      handlers(config, event, agent).some((entry) =>
        resemblesStroq(entryHandler(entry, agent), agent),
      ),
  );
  const failed =
    events.find((event) => event.state === 'changed') ??
    events.find((event) => event.state !== 'present');
  const disableAllHooks = config.disableAllHooks === true || config.hooksDisabled === true;
  const changedVersion = agent === 'cursor' && config.version !== expected.version && anyCandidate;
  return {
    state: disableAllHooks
      ? 'invalid'
      : changedVersion
        ? 'changed'
        : unknownCandidate
          ? 'changed'
          : failed
            ? anyCandidate
              ? 'changed'
              : 'missing'
            : 'present',
    reason: disableAllHooks
      ? 'hooks-disabled'
      : changedVersion
        ? 'hook-options-changed'
        : unknownCandidate
          ? 'hook-options-changed'
          : (failed?.reason ?? 'matches-current-install'),
    events: events.map(({ event, state }) => ({ event, state })),
  };
}
