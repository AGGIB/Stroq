import { isObject } from '../../packages/cli/src/harden/json-doc.ts';
import {
  validateMcpContainmentArtifact,
  type McpContainmentArtifact,
} from '../lib/mcp-containment.ts';
import type { McpRoot, McpSource } from './mcp-sources.ts';
import { binding, hash } from './mcp-containment-files.mjs';
import { publicArtifact, type Context } from './mcp-containment-vault.ts';
import { validStoredProxy, type StoredProxy } from './mcp-containment-proxy.ts';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Base = {
  id: string;
  name: string;
  artifact: McpContainmentArtifact;
  originWorkspaceId: string;
  sourceType: McpSource['source'];
  relativePath: string;
  sourceRootBinding: string;
  userBinding: string;
  vaultBinding: string;
  beforeSha256: string;
  beforeBytes: number;
  mode: number;
  createdAt: string;
  restoredAt: string | null;
};
export type LegacyManifest = Base & {
  schema: 'stroq-mcp-containment-record/1';
  removedSha256: string;
  removedBytes: number;
  phase: 'prepared' | 'removed' | 'restoring' | 'restored';
};
export type CurrentManifest = Base & {
  schema: 'stroq-mcp-containment-record/2';
  changedSha256: string;
  changedBytes: number;
  change: 'remove-registration' | 'protect-registration';
  changedEntrySha256: string | null;
  proxy: StoredProxy | null;
  phase: 'prepared' | 'removed' | 'configured' | 'restoring' | 'restored';
};
export type Manifest = LegacyManifest | CurrentManifest;
export const changeOf = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? ('remove-registration' as const) : m.change;
export const proxyOf = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? null : m.proxy;
export const changedEntrySha = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? null : m.changedEntrySha256;
export const changedSha = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? m.removedSha256 : m.changedSha256;
export const changedBytes = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? m.removedBytes : m.changedBytes;
export const changedFile = (m: Manifest) =>
  m.schema === 'stroq-mcp-containment-record/1' ? 'removed.json' : 'changed.json';
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const stamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const count = (v: unknown, max: number) =>
  Number.isInteger(v) && Number(v) >= 1 && Number(v) <= max;
const baseKeys = [
  'schema',
  'id',
  'name',
  'artifact',
  'originWorkspaceId',
  'sourceType',
  'relativePath',
  'sourceRootBinding',
  'userBinding',
  'vaultBinding',
  'beforeSha256',
  'beforeBytes',
  'mode',
  'createdAt',
  'restoredAt',
  'phase',
];
export function validManifest(v: unknown, ctx: Context, id: string, vault: McpRoot): v is Manifest {
  if (!isObject(v)) return false;
  const legacy = v.schema === 'stroq-mcp-containment-record/1';
  const keys = [
    ...baseKeys,
    ...(legacy
      ? ['removedSha256', 'removedBytes']
      : ['changedSha256', 'changedBytes', 'change', 'changedEntrySha256', 'proxy']),
  ];
  if (
    Object.keys(v).sort().join(',') !== keys.sort().join(',') ||
    (!legacy && v.schema !== 'stroq-mcp-containment-record/2') ||
    v.id !== id ||
    !UUID.test(id) ||
    typeof v.name !== 'string' ||
    !v.name.length ||
    v.name.length > 512 ||
    !validateMcpContainmentArtifact(v.artifact) ||
    typeof v.originWorkspaceId !== 'string' ||
    !/^workspace-[a-f0-9]{24}$/.test(v.originWorkspaceId) ||
    !['claude-desktop-manual', 'claude-code-project', 'cursor-project', 'cursor-user'].includes(
      String(v.sourceType),
    ) ||
    typeof v.relativePath !== 'string' ||
    v.relativePath.length > 512 ||
    !sha(v.sourceRootBinding) ||
    v.userBinding !== binding(ctx.user) ||
    v.vaultBinding !== binding(vault) ||
    !sha(v.beforeSha256) ||
    !sha(legacy ? v.removedSha256 : v.changedSha256) ||
    v.beforeSha256 === (legacy ? v.removedSha256 : v.changedSha256) ||
    !count(v.beforeBytes, 262144) ||
    !count(legacy ? v.removedBytes : v.changedBytes, 262144) ||
    !Number.isInteger(v.mode) ||
    Number(v.mode) < 0 ||
    Number(v.mode) > 511 ||
    !(Number(v.mode) & 0o200) ||
    !stamp(v.createdAt) ||
    !(v.restoredAt === null || (stamp(v.restoredAt) && v.restoredAt >= v.createdAt)) ||
    !['prepared', 'removed', ...(!legacy ? ['configured'] : []), 'restoring', 'restored'].includes(
      String(v.phase),
    ) ||
    (v.phase === 'restored' ? v.restoredAt === null : v.restoredAt !== null)
  )
    return false;
  if (!legacy) {
    if (v.change === 'remove-registration') {
      if (v.proxy !== null || v.changedEntrySha256 !== null || v.phase === 'configured')
        return false;
    } else if (v.change === 'protect-registration') {
      if (
        !sha(v.changedEntrySha256) ||
        v.changedEntrySha256 === v.artifact.sha256 ||
        !validStoredProxy(v.proxy) ||
        v.proxy.policyWorkspaceId !== v.originWorkspaceId ||
        v.proxy.policyWorkspaceId !== `workspace-${hash(v.proxy.cwd).slice(0, 24)}` ||
        v.phase === 'removed'
      )
        return false;
    } else return false;
  }
  try {
    const source = {
      source: v.sourceType,
      agent: v.artifact.agent,
      scope: v.artifact.scope,
    } as McpSource;
    return (
      JSON.stringify(publicArtifact(source, v.name, v.artifact.sha256)) ===
      JSON.stringify(v.artifact)
    );
  } catch {
    return false;
  }
}
