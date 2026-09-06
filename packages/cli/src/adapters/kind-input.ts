import type { Decision } from '@stroq/core';
import {
  applyPatchPaths,
  commandCandidates,
  commandOf,
  describeToolInput,
  isEmptyToolInput,
  patchTextOf,
} from './codex-input.js';
import { asPaths, type PreCandidates } from './pre-decision.js';
import { toolInputRecord } from './tool-input.js';

/**
 * Reading a tool call once, for every agent whose native tools come in these kinds.
 *
 * Copilot and OpenClaw name their tools differently and nothing else: past the name,
 * a shell call, a patch, a written path and a fetched URL arrive in the same fields
 * and have to be reduced to the same record, fanned out over the same candidate lists
 * and denied on the same "could not read it" condition. The two adapters ran
 * line-for-line copies of all three, and copies of a security check drift — a fix
 * landing in one adapter only is a bypass that reproduces on one agent, which is the
 * same reason the command, argv and patch readers are shared from `codex-input.ts`
 * rather than re-typed. `withCandidates` in particular is load-bearing: it is what
 * stops a payload's own `urls`/`file_paths` from choosing what gets judged.
 *
 * What stays in each adapter is what genuinely differs: which name maps to which
 * kind, which keys that agent's file tools have to drop, and how a deny is worded.
 */

/** What a native tool does, which decides both its Stroq name and its input shape. */
export type ToolKind = 'shell' | 'patch' | 'write' | 'read' | 'fetch' | 'plain' | 'mcp';

/** Where a file tool might put the path, the documented spelling first. */
const PATH_FIELDS = ['path', 'file_path', 'raw'] as const;

/**
 * Every distinct non-empty path candidate among `path`, `file_path` and `raw`, in
 * that order — not just the first: `{ path: 'safe.txt', file_path: '<protected>' }`
 * would otherwise let the protected value disappear behind whichever field a
 * first-match reader happened to check first. More than one candidate is judged the
 * way an `apply_patch`'s paths already are: `kindToolInput` exposes the whole list
 * under `file_paths` and `preCandidatesFor`/`preInputs` fan out one `engine.pre` per
 * path, worst wins.
 */
export const pathsOf = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const found = new Set<string>();
  for (const key of PATH_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.add(value);
  }
  return [...found];
};

/** Where a `web_fetch` call might put the URL, the documented spelling first. */
const URL_FIELDS = ['url', 'uri', 'href', 'raw'] as const;

/**
 * Every distinct non-empty URL candidate, read exactly the way `pathsOf` reads a
 * path — because the failure mode is the same and worse: core classifies `WebFetch`
 * on `url` alone and scans `url`/`prompt` for secret values, so a URL that does not
 * land in `url` as a string is a fetch with no host, no secret candidate and no
 * reason to deny. A bare-string argument object arrives under `raw`; an array of
 * strings contributes each element (a two-URL call is judged on both); anything else
 * contributes nothing, and a call left with no candidate at all is denied by
 * `unreadableGuard` rather than run through the engine as an empty fetch.
 */
export const urlsOf = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const found = new Set<string>();
  for (const key of URL_FIELDS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.add(value);
    else if (Array.isArray(value))
      for (const item of value) if (typeof item === 'string' && item !== '') found.add(item);
  }
  return [...found];
};

export const withoutKeys = (
  record: Readonly<Record<string, unknown>>,
  drop: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !drop.includes(key)));

/**
 * The record the engine sees for a call whose real subject is one of several
 * candidates: the first under the canonical key the classifier reads, and the whole
 * list under `<key>s` when they disagreed, which is what `preInputs` fans out over.
 *
 * The plural key is ALWAYS this function's, never the payload's — a caller-supplied
 * `urls`/`file_paths` is dropped whatever the candidate count. `preInputs` overwrites
 * the singular key with each entry of the plural one, so a payload that brought its
 * own list would decide what gets judged: `{ url: '<exfiltrating>', urls: ['<benign>',
 * '<benign>'] }` would be classified twice on the decoys and never once on the real
 * URL. Deleting the key unconditionally is what makes that impossible — writing the
 * computed list only when there is more than one candidate would still leave the
 * payload's own list in place for the single-candidate case, which is the common one.
 */
export const withCandidates = (
  base: Readonly<Record<string, unknown>>,
  key: 'file_path' | 'url',
  candidates: readonly string[],
): Record<string, unknown> => {
  const plural = `${key}s`;
  const one = { ...withoutKeys(base, [plural]), [key]: candidates[0] ?? '' };
  return candidates.length > 1 ? { ...one, [plural]: [...candidates] } : one;
};

/**
 * The record one tool call hands the engine. `droppedFileFields` is the only thing
 * that differs between agents: the key a file tool spells its path with has just been
 * rewritten as the `file_path` every rule, summary and audit line reads, and an agent
 * whose editor hides a sub-command in a field called `command` has to drop that too
 * (`summarizeInput` prefers a key of that name, so keeping it would label the call
 * after the sub-command instead of the file it touched).
 *
 * A `fetch` and an MCP call keep their whole record rather than being reduced to one
 * field: an MCP call's secret-egress check reads `JSON.stringify(toolInput)`, so a
 * field dropped here could never be caught leaving through `mcp.call` — which is what
 * a chat-message body and a browser form fill are.
 */
export function kindToolInput(
  kind: ToolKind,
  rawArgs: unknown,
  droppedFileFields: readonly string[],
): Record<string, unknown> {
  const record = toolInputRecord(rawArgs);
  if (kind === 'shell') return { command: commandOf(rawArgs) };
  if (kind === 'patch') {
    // A fresh object, so nothing of the payload's — a `file_paths` it brought with
    // it included — reaches the engine or drives the fan-out; see `withCandidates`.
    const paths = applyPatchPaths(patchTextOf(rawArgs));
    return { file_path: paths[0] ?? '', file_paths: [...paths] };
  }
  if (kind === 'write' || kind === 'read')
    return withCandidates(withoutKeys(record, droppedFileFields), 'file_path', pathsOf(record));
  if (kind === 'fetch') return withCandidates(record, 'url', urlsOf(record));
  return record;
}

/**
 * Everything this call has to be judged on separately. `file_paths` is populated by
 * `kindToolInput` for `patch` always and for `write`/`read` whenever a call's path
 * fields disagreed (see `pathsOf`), and `urls` for a `fetch` whose URL fields
 * disagreed (see `urlsOf`), so the fan-out applies uniformly: `preInputs` judges
 * every candidate and the worst wins, exactly how an `apply_patch`'s paths do.
 */
export const preCandidatesFor = (
  kind: ToolKind,
  rawArgs: unknown,
  toolInput: Readonly<Record<string, unknown>>,
): PreCandidates => ({
  commands: kind === 'shell' ? commandCandidates(rawArgs) : [],
  patchPaths:
    kind === 'patch' || kind === 'write' || kind === 'read' ? asPaths(toolInput['file_paths']) : [],
  urls: kind === 'fetch' ? asPaths(toolInput['urls']) : [],
});

/**
 * The four kinds whose arguments the reader above reduces to ONE field, and so the
 * four that can lose it: a shell command, a patch body, a written path and a fetched
 * URL. Everything else is either low impact or an MCP call, whose arguments ARE the
 * record and reach the engine whatever shape they arrived in.
 */
const READABLE: Readonly<
  Partial<
    Record<
      ToolKind,
      (toolInput: Readonly<Record<string, unknown>>, found: PreCandidates) => boolean
    >
  >
> = {
  shell: (_toolInput, found) => found.commands.length > 0,
  patch: (_toolInput, found) => found.patchPaths.length > 0,
  write: (toolInput) => toolInput['file_path'] !== '',
  fetch: (toolInput) => toolInput['url'] !== '',
};

/**
 * A high-impact call the agent sent arguments for, whose command, patch, path or URL
 * the reader could not find. Handing the engine the empty action it extracted would
 * classify nothing and allow the call — a `web_fetch` with an empty `url` classifies
 * to `network.fetch` with no host and no secret candidate, which is exactly the
 * fail-open this guard exists to stop — so it is denied instead. EMPTY arguments are
 * a different thing: there is nothing to act on, and the call keeps running through
 * the engine. MCP tools are never this: their arguments are the record itself, which
 * `toolInputRecord` fills whatever shape they arrived in, and the secret guard scans
 * it as it stands.
 *
 * `deny` is the adapter's own decision for this, named after the agent and given the
 * top-level KEYS of what arrived — never a value: the arguments are exactly where a
 * secret would be, and that reason is printed to the agent, logged and audited.
 */
export function unreadableGuard(
  kind: ToolKind,
  rawArgs: unknown,
  toolInput: Readonly<Record<string, unknown>>,
  found: PreCandidates,
  deny: (shape: string) => Decision,
): Decision | null {
  const readable = READABLE[kind];
  if (!readable || isEmptyToolInput(rawArgs)) return null;
  return readable(toolInput, found) ? null : deny(describeToolInput(rawArgs));
}
