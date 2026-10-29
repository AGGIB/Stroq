import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  validateInventory,
  validateInventoryItem,
  type InventoryItem,
  type InventoryState,
} from '../lib/inventory';
import {
  validateInventoryObservedArtifact,
  type InventoryObservedArtifact,
  type InventoryObservedChange,
} from '../lib/inventory-monitor';
import { SKILL_SOURCE_IDS, skillSourceOf } from '../lib/skill-sources';

export const observationHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const exact = (v: any, keys: string[]) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sort = <T>(values: T[]) => values.sort((a, b) => order(JSON.stringify(a), JSON.stringify(b)));
function validStrings(value: unknown) {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && (/[\uD800-\uDFFF]/u.test(item) || /\ufffd/u.test(item)))
      return false;
    if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  return true;
}
export interface ObservedFact {
  artifact: InventoryObservedArtifact;
  sha256: string;
  reliable: boolean;
  scan: InventoryItem['scan'];
  capabilities?: InventoryItem['capabilities'];
  mcp?: InventoryItem['mcp'];
}
export interface ObservationFacts {
  projectIsUser: boolean;
  items: ObservedFact[];
  sources: NonNullable<InventoryState['skillSources']>;
  gaps: InventoryState['gaps'];
  buckets: { id: string; complete: boolean }[];
}
const bucket = (a: Pick<InventoryItem, 'kind' | 'agent' | 'scope' | 'skillSource'>) =>
  `${a.kind}:${a.kind === 'skill' ? (skillSourceOf(a) ?? 'unknown') : a.agent}:${a.scope}`;
function artifact(item: InventoryItem): InventoryObservedArtifact {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    agent: item.agent,
    scope: item.scope,
    ...(item.kind === 'skill' && skillSourceOf(item) ? { skillSource: skillSourceOf(item)! } : {}),
    ...(item.location
      ? { location: { label: item.location.label, redacted: item.location.redacted } }
      : {}),
  };
}
/** A filesystem-only projection. Null hashes include reviewed ghosts and never assert presence. */
export function projectInventory(
  snapshot: InventoryState,
  { projectIsUser = false } = {},
): ObservationFacts {
  if (!validateInventory(snapshot) || !validStrings(snapshot))
    throw new Error('observation-store-invalid');
  const sources = sort(
    (snapshot.skillSources ?? []).map((s) => ({
      id: s.id,
      scope: s.scope,
      status: s.status,
      candidates: s.candidates,
    })),
  );
  const gaps = sort(
    snapshot.gaps.map((g) => ({
      code: g.code,
      agent: g.agent,
      scope: g.scope,
      kind: g.kind,
      ...(g.skillSource ? { skillSource: g.skillSource } : {}),
    })),
  );
  const items: ObservedFact[] = snapshot.items
    .filter((i) => i.sha256 !== null)
    .map((i) => ({
      artifact: artifact(i),
      sha256: i.sha256!,
      reliable: i.kind === 'mcp' || i.scan.status === 'clean' || i.scan.status === 'suspect',
      scan: { status: i.scan.status, findings: i.scan.findings },
      ...(i.capabilities
        ? { capabilities: sort(i.capabilities.map((c) => ({ kind: c.kind, count: c.count }))) }
        : {}),
      ...(i.mcp
        ? { mcp: { transport: i.mcp.transport, wrapper: i.mcp.wrapper, strict: i.mcp.strict } }
        : {}),
    }))
    .sort((a, b) => order(a.artifact.id, b.artifact.id));
  const buckets = new Map<string, boolean>();
  for (const source of SKILL_SOURCE_IDS)
    for (const scope of projectIsUser ? (['user'] as const) : (['project', 'user'] as const)) {
      const coverage = sources.find((s) => s.id === source && s.scope === scope);
      buckets.set(
        `skill:${source}:${scope}`,
        coverage?.status === 'complete' || coverage?.status === 'absent',
      );
    }
  // Current inventory examines these supported JSON scopes. Multiple Windsurf sources share
  // one conservative bucket because public metadata does not identify their physical source.
  for (const [agent, scope] of [
    ['claude-desktop', 'user'],
    ['windsurf', 'user'],
    ['cursor', 'project'],
    ['cursor', 'user'],
    ['claude-code', 'project'],
  ])
    if (!(projectIsUser && agent === 'cursor' && scope === 'project'))
      buckets.set(`mcp:${agent}:${scope}`, true);
  for (const g of gaps)
    for (const [key] of buckets) {
      const [kind, source, scope] = key.split(':');
      if (!['skill', 'mcp'].includes(g.kind)) {
        buckets.set(key, false);
        continue;
      }
      if (g.kind !== kind || (['project', 'user'].includes(g.scope) && g.scope !== scope)) continue;
      const knownAgent = ['claude-desktop', 'windsurf', 'cursor', 'claude-code'].includes(g.agent);
      if (
        kind === 'mcp'
          ? !knownAgent || g.agent === source
          : !g.skillSource || g.skillSource === source
      )
        buckets.set(key, false);
    }
  for (const item of items) {
    const key = bucket(item.artifact);
    if (!buckets.has(key) || !item.reliable) buckets.set(key, false);
  }
  return {
    projectIsUser,
    items,
    sources,
    gaps,
    buckets: [...buckets]
      .map(([id, complete]) => ({ id, complete }))
      .sort((a, b) => order(a.id, b.id)),
  };
}
export function observationSummary(facts: ObservationFacts) {
  const incomplete = facts.buckets.filter((b) => !b.complete).length;
  return {
    itemCount: facts.items.length,
    complete: incomplete === 0 && facts.gaps.length === 0,
    gaps: facts.gaps.length + incomplete,
  };
}
/** Reject arbitrary private metadata by reconstructing the same strict public source facts. */
export function validateObservationFacts(value: unknown): value is ObservationFacts {
  const v = value as ObservationFacts;
  if (
    !exact(v, ['projectIsUser', 'items', 'sources', 'gaps', 'buckets']) ||
    typeof v.projectIsUser !== 'boolean' ||
    !Array.isArray(v.items) ||
    v.items.length > 512 ||
    !Array.isArray(v.sources) ||
    !Array.isArray(v.gaps) ||
    !Array.isArray(v.buckets)
  )
    return false;
  for (const item of v.items) {
    if (
      !item ||
      !Object.keys(item).every((k) =>
        ['artifact', 'sha256', 'reliable', 'scan', 'capabilities', 'mcp'].includes(k),
      ) ||
      !validateInventoryObservedArtifact(item.artifact) ||
      !SHA.test(item.sha256) ||
      typeof item.reliable !== 'boolean'
    )
      return false;
    const reconstructed = {
      ...item.artifact,
      sha256: item.sha256,
      reviewedSha256: null,
      state: 'unreviewed',
      fileType: item.artifact.kind === 'skill' ? 'skill-tree' : 'mcp-config',
      scan: item.scan,
      ...(item.capabilities ? { capabilities: item.capabilities } : {}),
      ...(item.mcp ? { mcp: item.mcp } : {}),
    };
    if (!validateInventoryItem(reconstructed)) return false;
  }
  try {
    const snapshot = {
      schema: 'stroq-inventory/1',
      source: 'local',
      generatedAt: '2026-01-01T00:00:00.000Z',
      workspace: { id: `workspace-${'a'.repeat(24)}`, label: 'Observation' },
      baseline: { status: 'missing', reviewedAt: null },
      limitations: [],
      items: v.items.map((i) => ({
        ...i.artifact,
        sha256: i.sha256,
        reviewedSha256: null,
        state: 'unreviewed',
        fileType: i.artifact.kind === 'skill' ? 'skill-tree' : 'mcp-config',
        scan: i.scan,
        ...(i.capabilities ? { capabilities: i.capabilities } : {}),
        ...(i.mcp ? { mcp: i.mcp } : {}),
      })),
      skillSources: v.sources,
      gaps: v.gaps,
    } as InventoryState;
    return isDeepStrictEqual(v, projectInventory(snapshot, { projectIsUser: v.projectIsUser }));
  } catch {
    return false;
  }
}
export function compareObservations(before: ObservationFacts, after: ObservationFacts) {
  const oldItems = new Map(before.items.map((i) => [i.artifact.id, i]));
  const newItems = new Map(after.items.map((i) => [i.artifact.id, i]));
  const oldBuckets = new Map(before.buckets.map((b) => [b.id, b.complete]));
  const newBuckets = new Map(after.buckets.map((b) => [b.id, b.complete]));
  const rows: InventoryObservedChange[] = [];
  for (const id of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) {
    const prior = oldItems.get(id),
      current = newItems.get(id);
    if (prior && current && isDeepStrictEqual(prior, current)) continue;
    const item = current ?? prior!;
    const sameSource = !prior || !current || bucket(prior.artifact) === bucket(current.artifact);
    const complete =
      sameSource &&
      oldBuckets.get(bucket(item.artifact)) === true &&
      newBuckets.get(bucket(item.artifact)) === true;
    let kind: InventoryObservedChange['kind'];
    if (prior && current)
      kind =
        prior.reliable && current.reliable && sameSource && prior.sha256 !== current.sha256
          ? 'changed'
          : 'unverifiable';
    else if (current) kind = complete && current.reliable ? 'added' : 'observed';
    else kind = complete && prior!.reliable ? 'removed' : 'unverifiable';
    rows.push({
      kind,
      artifact: structuredClone(item.artifact),
      beforeSha256: prior?.sha256 ?? null,
      afterSha256: current?.sha256 ?? null,
    });
  }
  return {
    status:
      observationSummary(before).complete && observationSummary(after).complete
        ? ('comparable' as const)
        : ('partial' as const),
    total: rows.length,
    rows: rows.slice(0, 64),
    omitted: Math.max(0, rows.length - 64),
  };
}
