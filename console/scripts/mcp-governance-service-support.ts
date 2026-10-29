import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { readPolicyState, samePolicyRevision } from './policy-files.mjs';
import { createMcpGovernanceStore } from './mcp-governance-store';
import * as boundary from '../lib/mcp-governance';
import type { McpGovernanceStoreEntry } from './mcp-governance-store-types';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code: string): never {
  throw Error(code);
}
export const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const success = (body: unknown) => ({ status: 200, body: structuredClone(body) });
const aliases: Record<string, string> = {
  'invalid-request': 'mcp-governance-invalid',
  'no-changes': 'mcp-governance-no-changes',
  'policy-invalid': 'mcp-governance-unsupported',
  'policy-unavailable': 'mcp-governance-unavailable',
  'stale-policy': 'mcp-governance-policy-changed',
  busy: 'mcp-governance-busy',
  'policy-cases-busy': 'mcp-governance-busy',
  'policy-cases-stale': 'mcp-governance-stale',
  'policy-restore-unknown': 'mcp-governance-write-unconfirmed',
};
export function failure(error: unknown) {
  const raw = error instanceof Error ? error.message : '',
    mapped = aliases[raw] ?? raw;
  const code = boundary.MCP_GOVERNANCE_ERRORS.includes(mapped as any)
    ? mapped
    : 'mcp-governance-unavailable';
  const status = /invalid$/.test(code)
    ? 400
    : /stale|changed|expired|busy|recovery-required/.test(code)
      ? 409
      : /unavailable$/.test(code)
        ? 503
        : 422;
  return { status, body: { error: code } };
}
export const directoryPin = ({ dev, ino, uid, mode }: any) => ({ dev, ino, uid, mode });
export const filePin = (file: any, renamed = false): any =>
  file === null
    ? null
    : {
        ...directoryPin(file),
        nlink: file.nlink,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ...(!renamed ? { ctimeMs: file.ctimeMs } : {}),
      };
export const parentsPin = (capture: any) => capture.directories.map(directoryPin);
export const unavailableCurrent = () => ({ policyVersion: null, gate: 'unavailable', allowed: [] });
export function publicRecord(entry: McpGovernanceStoreEntry, current: any) {
  const r = entry.intent;
  return {
    id: r.id,
    operationId: r.operationId,
    revision: entry.revision,
    binding: r.binding,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.phase === 'applied' || r.phase === 'not-applied' ? r.phase : 'unknown',
    candidateRawSha256: r.candidateRawSha256,
    candidateFingerprint: r.candidateFingerprint,
    historyRef: r.historyRef,
    current: !current
      ? 'unavailable'
      : current.policy.rawSha === r.candidateRawSha256 &&
          current.inspection.policyFingerprint === r.candidateFingerprint
        ? 'matches'
        : 'changed',
    hostEnforcement: false,
  };
}
export function unconfirmed(entries: McpGovernanceStoreEntry[]) {
  return entries
    .filter((e) => ['prepared', 'staged'].includes(e.intent.phase))
    .map((e) => ({
      id: e.intent.id,
      revision: e.revision,
      operationId: e.intent.operationId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function createGovernanceContext(options: any, signal: AbortSignal) {
  const home = resolve(options.home);
  async function load() {
    if (signal.aborted) fail('mcp-governance-unavailable');
    const project = await rootIdentity(options.project),
      user = await rootIdentity(options.userHome);
    const contextId = `governance-context-${hash({ home, project, user })}`;
    const runtimeSha256 = await options.runtimeDigest();
    if (!digest(runtimeSha256)) fail('mcp-governance-unavailable');
    const policy = await readPolicyState(home);
    if (!policy) fail('mcp-governance-unavailable');
    const inspection = await options.adapter('mcp-governance-inspect', policy.text, undefined, {
      signal,
    });
    if (
      !inspection ||
      !boundary.validateMcpGovernanceCurrent(inspection.current) ||
      inspection.current.gate === 'unavailable' ||
      !digest(inspection.policyFingerprint) ||
      !Array.isArray(inspection.allowed) ||
      inspection.allowed.length > 64 ||
      inspection.allowed.some(
        (p: any) =>
          !p ||
          Reflect.ownKeys(p).length !== 2 ||
          !boundary.MCP_GOVERNANCE_CHANNELS.includes(p.channel) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p.name),
      ) ||
      new Set(inspection.allowed.map(hash)).size !== inspection.allowed.length ||
      inspection.current.allowed.length !== inspection.allowed.length
    )
      fail('mcp-governance-unavailable');
    if (!samePolicyRevision(policy, await readPolicyState(home)))
      fail('mcp-governance-policy-changed');
    if (runtimeSha256 !== (await options.runtimeDigest())) fail('mcp-governance-runtime-changed');
    const store = createMcpGovernanceStore({
      home,
      contextId,
      workspaceId: options.workspaceId,
      now: options.now,
    });
    return { contextId, runtimeSha256, policy, inspection, store, project, user };
  }
  async function sources(c: any) {
    const proxyRuntime = options.cli
      ? {
          fingerprint: c.runtimeSha256,
          command: process.execPath,
          entry: options.cli,
          home,
          userHome: c.user.path,
        }
      : undefined;
    return options.adapter(
      'mcp-governance-capture',
      null,
      {
        options: {
          project: c.project.path,
          userHome: c.user.path,
          home,
          platform: options.platform ?? process.platform,
          mcpEnvironment: options.mcpEnvironment ?? {},
          codexEnvironment: options.codexEnvironment ?? {},
          contextId: c.contextId,
          policyFingerprint: c.inspection.policyFingerprint,
          proxyRuntime,
        },
        allowed: c.inspection.allowed,
      },
      { signal },
    );
  }
  async function assertContext(c: any, sourceSha?: string) {
    if (signal.aborted || c.runtimeSha256 !== (await options.runtimeDigest()))
      fail('mcp-governance-runtime-changed');
    if (
      !isDeepStrictEqual(c.project, await rootIdentity(options.project)) ||
      !isDeepStrictEqual(c.user, await rootIdentity(options.userHome))
    )
      fail('mcp-governance-stale');
    if (sourceSha && (await sources(c)).sha256 !== sourceSha) fail('mcp-governance-source-changed');
  }
  async function assertPolicy(c: any) {
    if (!samePolicyRevision(c.policy, await readPolicyState(home)))
      fail('mcp-governance-policy-changed');
  }
  async function bindCreatedHome(c: any, createdHome: any) {
    if (c.policy.rootStat !== null) return assertPolicy(c);
    if (!createdHome || c.policy.rawSha !== null) fail('mcp-governance-policy-changed');
    const source = await snapshotFile(c.policy.captureRoot, c.policy.path, 256 * 1024);
    const current = await readPolicyState(home);
    if (!current) fail('mcp-governance-unavailable');
    const actualRoot = await rootIdentity(home);
    if (
      current.rawSha !== null ||
      createdHome.dev !== actualRoot.dev ||
      createdHome.ino !== actualRoot.ino ||
      (Object.hasOwn(createdHome, 'path') && !isDeepStrictEqual(createdHome, actualRoot)) ||
      !c.policy.capture.directories.every((d: any, i: number) =>
        isDeepStrictEqual(d, source.directories[i]),
      )
    )
      fail('mcp-governance-policy-changed');
    c.policy = current;
  }
  return { home, load, sources, assertContext, assertPolicy, bindCreatedHome };
}
