import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  mcpIdentityFromEncodedTool,
  mcpIdentityFromServer,
  redact,
  stableStringify,
} from '@stroq/core';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import { wrapperIndex } from '../../packages/cli/src/commands/mcp-config.ts';
import type {
  McpGovernanceChannel,
  McpGovernancePairSummary,
  McpGovernanceReason,
} from '../lib/mcp-governance-types.ts';
import type { ProxyRuntime } from './mcp-containment-proxy.ts';

export type GovernancePair = { channel: McpGovernanceChannel; name: string };
export const governanceHash = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');
export const governanceObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function governancePairSummary(pair: GovernancePair): McpGovernancePairSummary {
  const sha256 = governanceHash(pair),
    name = pair.name;
  const safe =
    /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(name) &&
    redact(name) === name &&
    !/(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(name) &&
    !/(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
      name,
    );
  return {
    channel: pair.channel,
    label: safe ? name : `MCP server ${sha256.slice(0, 8)}`,
    redacted: !safe,
    identitySha256: sha256,
  };
}
export function governanceNameEligibility(pair: GovernancePair): {
  eligibility: 'eligible' | 'unsupported' | 'ambiguous';
  reason: McpGovernanceReason | null;
} {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pair.name))
    return { eligibility: 'unsupported', reason: 'unsupported-name' };
  const witness =
    pair.channel === 'claude-code' || pair.channel === 'codex'
      ? mcpIdentityFromEncodedTool(pair.channel, `mcp__${pair.name}__call`)
      : mcpIdentityFromServer(pair.channel, pair.name);
  if (witness?.kind !== 'server')
    return witness?.kind === 'unavailable' && witness.reason === 'ambiguous'
      ? { eligibility: 'ambiguous', reason: 'ambiguous-identity' }
      : { eligibility: 'unsupported', reason: 'unsupported-name' };
  return { eligibility: 'eligible', reason: null };
}
/** Presence is configuration metadata only; no command, URL or environment is executed. */
export function governanceRegistration(entry: unknown): boolean {
  if (!governanceObject(entry)) return false;
  const text = (v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= 16384 && !v.includes('\0');
  if (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean') return false;
  const http = text(entry.url) || text(entry.serverUrl);
  const stdio =
    text(entry.command) &&
    (!Object.hasOwn(entry, 'args') ||
      (Array.isArray(entry.args) &&
        entry.args.length <= 256 &&
        entry.args.every(
          (v: unknown) => typeof v === 'string' && v.length <= 16384 && !v.includes('\0'),
        )));
  return Boolean(http || stdio);
}
const wrapperShaped = (entry: Record<string, any>, args: unknown[]) =>
  wrapperIndex(args) !== null ||
  /(?:^|[/\\])stroq(?:\.(?:cmd|exe|js|mjs|cjs))?$/i.test(String(entry.command)) ||
  args.some((v, i) => {
    const previous = args[i - 1];
    return (
      v === 'mcp' &&
      i > 0 &&
      typeof previous === 'string' &&
      /(?:^|[/\\])index\.[cm]?[jt]s$/.test(previous)
    );
  }) ||
  args.some((v) => typeof v === 'string' && /^@stroq\/cli(?:@[^\s]+)?$/.test(v));
export function governanceProxyPair(
  entry: unknown,
  runtime: ProxyRuntime | undefined,
  home: string,
  userHome: string,
): {
  pair: GovernancePair | null;
  gap: 'proxy-unverified' | 'proxy-other-home' | null;
} {
  if (!governanceObject(entry)) return { pair: null, gap: null };
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (!wrapperShaped(entry, args)) return { pair: null, gap: null };
  const env = governanceObject(entry.env) ? entry.env : {};
  if (typeof env.STROQ_HOME === 'string' && env.STROQ_HOME !== home)
    return { pair: null, gap: 'proxy-other-home' };
  if (
    !runtime ||
    !/^[a-f0-9]{64}$/.test(runtime.fingerprint) ||
    runtime.home !== home ||
    runtime.userHome !== userHome ||
    Object.hasOwn(entry, 'url') ||
    Object.hasOwn(entry, 'serverUrl') ||
    (Object.hasOwn(entry, 'type') && entry.type !== 'stdio') ||
    (Object.hasOwn(entry, 'transport') && entry.transport !== 'stdio') ||
    !isAbsolute(runtime.command) ||
    !isAbsolute(runtime.entry) ||
    entry.command !== runtime.command ||
    args[0] !== runtime.entry ||
    args[1] !== 'mcp' ||
    wrapperIndex(args) !== 1 ||
    !args.every((v) => typeof v === 'string' && v.length <= 16384 && !v.includes('\0')) ||
    env.STROQ_HOME !== home ||
    env.HOME !== userHome ||
    env.USERPROFILE !== userHome ||
    Object.keys(env).some(
      (k) => /^(?:NODE_|LD_|DYLD_)/.test(k) || (/^STROQ_/.test(k) && k !== 'STROQ_HOME'),
    )
  )
    return { pair: null, gap: 'proxy-unverified' };
  const parsed = parseMcpArgv(args.slice(2));
  if (
    !parsed.ok ||
    parsed.invocation.cwd === null ||
    !isAbsolute(parsed.invocation.cwd) ||
    parsed.invocation.passEnv === null ||
    parsed.invocation.passEnv.some(
      (k) =>
        /^(?:NODE_|STROQ_|LD_|DYLD_)|^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)$/.test(k) ||
        !Object.hasOwn(env, k),
    )
  )
    return { pair: null, gap: 'proxy-unverified' };
  return { pair: { channel: 'mcp-proxy', name: parsed.invocation.server }, gap: null };
}
