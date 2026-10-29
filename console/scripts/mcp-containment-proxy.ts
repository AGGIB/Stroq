import { isAbsolute } from 'node:path';
import { wrapMcpConfig, wrapperIndex } from '../../packages/cli/src/commands/mcp-config.ts';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import { deepEqual, isObject } from '../../packages/cli/src/harden/json-doc.ts';
import type { JsonObject } from '../../packages/cli/src/harden/types.ts';
import { mcpEntryMetadata } from './mcp-sources.ts';

/** Server-selected installed runtime, never a browser executable/path argument. */
export type ProxyRuntime = {
  fingerprint: string;
  command: string;
  entry: string;
  home: string;
  userHome: string;
};
export type StoredProxy = {
  mode: 'strict';
  toolApproval?: true;
  policyWorkspaceId: string;
  cwd: string;
  runtime: ProxyRuntime;
};
const path = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && isAbsolute(v) && !v.includes('\0');
export function validRuntime(v: unknown): v is ProxyRuntime {
  return (
    isObject(v) &&
    Object.keys(v).sort().join(',') === 'command,entry,fingerprint,home,userHome' &&
    typeof v.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(v.fingerprint) &&
    path(v.command) &&
    path(v.entry) &&
    path(v.home) &&
    path(v.userHome)
  );
}
export function validStoredProxy(v: unknown): v is StoredProxy {
  return (
    isObject(v) &&
    Object.keys(v).every((key) =>
      ['cwd', 'mode', 'policyWorkspaceId', 'runtime', 'toolApproval'].includes(key),
    ) &&
    (!Object.hasOwn(v, 'toolApproval') || v.toolApproval === true) &&
    v.mode === 'strict' &&
    typeof v.policyWorkspaceId === 'string' &&
    /^workspace-[a-f0-9]{24}$/.test(v.policyWorkspaceId) &&
    path(v.cwd) &&
    validRuntime(v.runtime)
  );
}
export const publicProxy = (v: StoredProxy | null) =>
  v === null
    ? null
    : {
        mode: v.mode,
        policyWorkspaceId: v.policyWorkspaceId,
        ...(v.toolApproval ? { toolApproval: true as const } : {}),
      };
const controlEnv = /^(?:NODE_|STROQ_|LD_|DYLD_)|^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)$/;
export const sameRuntime = (a: ProxyRuntime, b: ProxyRuntime) =>
  a.fingerprint === b.fingerprint &&
  a.command === b.command &&
  a.entry === b.entry &&
  a.home === b.home &&
  a.userHome === b.userHome;
const entryShape = /(?:^|[/\\])(?:index\.[cm]?[jt]s|stroq(?:\.[cm]?[jt]s)?)$/i;
const hasProxyPrefix = (args: readonly unknown[]) =>
  args.some(
    (token, i) =>
      token === 'mcp' &&
      i > 0 &&
      typeof args[i - 1] === 'string' &&
      entryShape.test(args[i - 1] as string),
  );
const safeText = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
function eligible(entry: unknown, name: string): asserts entry is JsonObject {
  if (
    !isObject(entry) ||
    !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(name) ||
    !safeText(entry.command) ||
    !entry.command.length ||
    entry.command.length > 4096 ||
    Object.hasOwn(entry, 'url') ||
    Object.hasOwn(entry, 'serverUrl') ||
    (Object.hasOwn(entry, 'type') && entry.type !== 'stdio') ||
    (Object.hasOwn(entry, 'transport') && entry.transport !== 'stdio') ||
    (Object.hasOwn(entry, 'args') &&
      (!Array.isArray(entry.args) || entry.args.length > 256 || !entry.args.every(safeText))) ||
    /(?:^|[/\\])stroq(?:\.cmd|\.exe|\.js|\.mjs|\.cjs)?$/i.test(entry.command) ||
    wrapperIndex(Array.isArray(entry.args) ? entry.args : []) !== null ||
    hasProxyPrefix(Array.isArray(entry.args) ? entry.args : []) ||
    (Array.isArray(entry.args) &&
      entry.args.includes('mcp') &&
      entry.args.some((arg) => typeof arg === 'string' && /^@stroq\/cli(?:@[^\s]+)?$/.test(arg)))
  )
    throw new Error('mcp-containment-unsupported');
  if (Object.hasOwn(entry, 'env')) {
    if (
      !isObject(entry.env) ||
      Object.keys(entry.env).length > 256 ||
      Object.entries(entry.env).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || controlEnv.test(key) || !safeText(value),
      )
    )
      throw new Error('mcp-containment-unsupported');
  }
}
/** One isolated own registration only; CLI init's whole-file writer is never called. */
export function strictProxyEntry(entry: unknown, name: string, client: string, proxy: StoredProxy) {
  eligible(entry, name);
  if (!validStoredProxy(proxy)) throw new Error('mcp-containment-unavailable');
  const wrapped = wrapMcpConfig(
    { mcpServers: { [name]: entry } },
    {
      node: proxy.runtime.command,
      entryArgv: [proxy.runtime.entry],
      client,
      cwd: proxy.cwd,
      strict: true,
    },
  ).config.mcpServers;
  if (!isObject(wrapped) || !Object.hasOwn(wrapped, name) || !isObject(wrapped[name]))
    throw new Error('mcp-containment-unavailable');
  let result = wrapped[name];
  if (proxy.toolApproval && Array.isArray(result.args)) {
    const separator = result.args.indexOf('--');
    if (separator < 0) throw new Error('mcp-containment-unavailable');
    result = {
      ...result,
      args: [
        ...result.args.slice(0, separator),
        '--tool-approval',
        ...result.args.slice(separator),
      ],
    };
  }
  const args = result.args;
  const parsed = Array.isArray(args) && args.every(safeText) ? parseMcpArgv(args.slice(2)) : null;
  if (
    !parsed?.ok ||
    parsed.invocation.strict !== true ||
    (parsed.invocation.toolApproval === true) !== (proxy.toolApproval === true) ||
    parsed.invocation.cloak ||
    parsed.invocation.pin !== undefined ||
    parsed.invocation.server !== name ||
    parsed.invocation.client !== client ||
    parsed.invocation.cwd !== proxy.cwd ||
    parsed.invocation.command !== entry.command ||
    !deepEqual(parsed.invocation.args as string[], (entry.args ?? []) as string[]) ||
    !deepEqual(
      { ...result, command: entry.command, args: entry.args ?? [] },
      { ...entry, args: entry.args ?? [] },
    )
  )
    throw new Error('mcp-containment-unavailable');
  const sha256 = mcpEntryMetadata(result).sha256;
  if (!sha256) throw new Error('mcp-containment-unavailable');
  const guarded = {
    ...result,
    env: {
      ...(isObject(entry.env) ? entry.env : {}),
      STROQ_HOME: proxy.runtime.home,
      HOME: proxy.runtime.userHome,
      USERPROFILE: proxy.runtime.userHome,
    },
  };
  const guardedSha256 = mcpEntryMetadata(guarded).sha256;
  if (!guardedSha256) throw new Error('mcp-containment-unavailable');
  return { entry: guarded, sha256: guardedSha256 };
}
